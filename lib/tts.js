/**
 * 文字转语音（"嘴"）：本机 IndexTTS 服务（HTTP）合成 wav，供 napcat_send_voice 发 record 段。
 *
 * 不引第三方依赖：直接 fetch 本地 /tts。任何一步失败都返回 null 并记日志，由调用方降级。
 * 服务没起来（ECONNREFUSED / fetch failed）时自动拉起一次，等 /health 就绪后重试一次。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureTempDir } from './media.js';
import { withGpu } from './gpu.js';
/** 八维情绪（顺序与 TTS 服务一致）：happy,angry,sad,afraid,disgusted,melancholic,surprised,calm */
const EMOTIONS = {
    happy: '1,0,0,0,0,0,0,0',
    angry: '0,1,0,0,0,0,0,0',
    sad: '0,0,1,0,0,0,0,0',
    afraid: '0,0,0,1,0,0,0,0',
    disgusted: '0,0,0,0,1,0,0,0',
    melancholic: '0,0,0,0,0,1,0,0',
    surprised: '0,0,0,0,0,0,1,0',
    calm: '0,0,0,0,0,0,0,1',
    '高兴': '1,0,0,0,0,0,0,0',
    '生气': '0,1,0,0,0,0,0,0',
    '难过': '0,0,1,0,0,0,0,0',
    '害怕': '0,0,0,1,0,0,0,0',
    '嫌弃': '0,0,0,0,1,0,0,0',
    '没劲': '0,0,0,0,0,1,0,0',
    '惊讶': '0,0,0,0,0,0,1,0',
    '平静': '0,0,0,0,0,0,0,1',
};
/** 情绪名 → 八维向量；也接受已经写好的 "0,0,...,1" 逗号串。非法值返回 undefined。 */
export function emotionVector(emotion) {
    const raw = String(emotion ?? '').trim();
    if (raw === '')
        return EMOTIONS.calm;
    if (/^[0-9.]+\s*(,\s*[0-9.]+\s*){7}$/.test(raw))
        return raw.replace(/\s+/g, '');
    return EMOTIONS[raw.toLowerCase()] ?? EMOTIONS[raw];
}
/** 自动拉起的默认启动器（可用环境变量覆盖；路径不存在就不自愈）。 */
const DEFAULT_TTS_PYTHON = 'D:/NapCat/tts/index-tts/.venv/Scripts/python.exe';
const DEFAULT_TTS_SERVER = 'D:/NapCat/tts/tts_server.py';
const DEFAULT_TTS_LOG = 'D:/NapCat/tts/logs/tts_server.out';
const START_POLL_MS = 500;
const START_TIMEOUT_MS = 90000;
/** 模块级单例：并发请求共用同一次拉起，避免各起一个进程。 */
let autoStart;
/** 测试用：清掉拉起单例（生产代码不需要调用）。 */
export function resetTtsAutoStart() {
    autoStart = undefined;
}
/** 并发上限：同时在排队/合成的条数（显存只够一两条）。 */
let pending = 0;
const MAX_PENDING = 2;
/** 合成一段语音到临时 wav，返回绝对路径；失败/超时返回 null（不抛）。 */
export function synthesizeToWav(text, config, log, deps = {}) {
    if (config.ttsEnabled === false)
        return Promise.resolve(null);
    if (pending >= MAX_PENDING) {
        log('warn', 'TTS 排队已满（' + pending + ' 条），跳过: ' + text.slice(0, 20));
        return Promise.resolve(null);
    }
    pending += 1;
    return withGpu(() => synthesizeOnce(text, config, log, deps)).finally(() => { pending -= 1; });
}
async function synthesizeOnce(text, config, log, deps) {
    const first = await synthesizeAttempt(text, config, log, deps);
    if (first.wav !== null || first.error === undefined)
        return first.wav;
    if (!isConnectionError(first.error))
        return null;
    if (config.ttsAutoStart === false) {
        log('debug', 'TTS 服务没起；ttsAutoStart=false，不自动拉起');
        return null;
    }
    if (!(await ensureTtsServer(config, log, deps)))
        return null;
    log('info', 'TTS 服务已就绪，重试合成: ' + text.slice(0, 20));
    return (await synthesizeAttempt(text, config, log, deps)).wav;
}
async function synthesizeAttempt(text, config, log, deps) {
    const emo = emotionVector(config.ttsEmotion);
    if (emo === undefined) {
        log('warn', 'TTS 情绪值不认识: ' + String(config.ttsEmotion));
        return { wav: null };
    }
    const url = String(config.ttsServerUrl ?? '').replace(/\/+$/, '');
    const query = new URLSearchParams({
        text,
        voice: String(config.ttsVoiceRef ?? ''),
        lang: 'ZH',
        emo,
        alpha: '0.6',
        speed: String(config.ttsSpeed ?? 1.0),
    });
    const timeoutMs = Number(config.ttsTimeoutMs ?? 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await (deps.fetch ?? fetch)(url + '/tts?' + query.toString(), { signal: controller.signal });
        if (!response.ok)
            throw new Error('HTTP ' + response.status);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 44 || buffer.subarray(0, 4).toString('latin1') !== 'RIFF')
            throw new Error('返回的不是 wav（' + buffer.length + ' 字节）');
        const dir = await ensureTempDir();
        const wav = join(dir, 'tts-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.wav');
        await writeFile(wav, buffer);
        log('debug', 'TTS 合成: ' + text.slice(0, 20) + ' → ' + wav);
        return { wav };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('warn', 'TTS 合成失败（' + message + '）: ' + text.slice(0, 20));
        return { wav: null, error };
    }
    finally {
        clearTimeout(timer);
    }
}
/** fetch 的连接层错误（端口不通），顺着 cause 链找 ECONNREFUSED / "fetch failed"。 */
function isConnectionError(error) {
    let current = error;
    for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
        const value = current;
        if (value.code === 'ECONNREFUSED' || value.code === 'ECONNRESET' || value.code === 'ETIMEDOUT' || value.code === 'EHOSTUNREACH')
            return true;
        if (typeof value.message === 'string' && /fetch failed|ECONNREFUSED|not reachable/i.test(value.message))
            return true;
        current = value.cause;
    }
    return false;
}
/** 服务没起时拉起并等就绪；同一时刻只跑一次（并发请求共用同一个 Promise）。失败后放开，下次请求可再试。 */
export function ensureTtsServer(config, log, deps = {}) {
    if (autoStart === undefined) {
        // 只在「正在拉起」期间共用；结束就放开，服务以后再挂还能重新拉起。
        autoStart = startTtsServer(config, log, deps).finally(() => { autoStart = undefined; });
    }
    return autoStart;
}
async function startTtsServer(config, log, deps) {
    const url = String(config.ttsServerUrl ?? '').replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        log('warn', 'TTS 服务地址不合法，跳过自动拉起: ' + url);
        return false;
    }
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
        log('warn', 'TTS 服务不在本机（' + parsed.hostname + '），跳过自动拉起');
        return false;
    }
    const python = process.env.NAPCAT_TTS_PYTHON ?? DEFAULT_TTS_PYTHON;
    const server = process.env.NAPCAT_TTS_SERVER ?? DEFAULT_TTS_SERVER;
    const exists = deps.exists ?? existsSync;
    if (!exists(server) || !exists(python)) {
        log('warn', 'TTS 服务自愈跳过，启动器不存在: ' + (!exists(server) ? server : python));
        return false;
    }
    const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
    log('info', 'TTS 服务没起，自动拉起: ' + server);
    const fd = openLog(deps.logFile ?? DEFAULT_TTS_LOG);
    try {
        const child = (deps.spawn ?? spawn)(python, [server, '--port', port, '--warmup'], {
            detached: true,
            stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd],
            windowsHide: true,
        });
        // spawn 失败是异步 'error' 事件，没监听会直接崩宿主进程。
        child.on('error', error => log('warn', 'TTS 服务拉起失败: ' + (error instanceof Error ? error.message : String(error))));
        child.unref();
    }
    catch (error) {
        log('warn', 'TTS 服务拉起失败: ' + (error instanceof Error ? error.message : String(error)));
        return false;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
    const fetchImpl = deps.fetch ?? fetch;
    const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await healthReady(parsed.origin, fetchImpl)) {
            log('info', 'TTS 服务已就绪（自动拉起）');
            return true;
        }
        await sleep(START_POLL_MS);
    }
    log('warn', 'TTS 服务拉起后 ' + START_TIMEOUT_MS / 1000 + ' 秒内未就绪，放弃本次自愈');
    return false;
}
async function healthReady(base, fetchImpl) {
    try {
        const response = await fetchImpl(base + '/health');
        if (!response.ok)
            return false;
        const body = await response.json();
        return body?.ok === true && body?.loaded === true;
    }
    catch {
        return false;
    }
}
/** 追加写日志文件；开不了就退回 'ignore'（不能因为日志目录挂掉不自愈）。 */
function openLog(path) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        return openSync(path, 'a');
    }
    catch {
        return undefined;
    }
}
