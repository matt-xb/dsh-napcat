/**
 * 唱歌（"嗓子"）：简谱 → DiffSinger 歌声合成 → Seed-VC 音色转换 → wav，供 napcat_sing 发 record 段。
 *
 * 全离线、本机跑：SVS 出 24kHz 原唱，Seed-VC 转成当前音色预设（src/ttsvoice.ts 解析）出 44.1kHz。
 * Seed-VC 峰值显存 11–13 GiB，所以整链走 gpu.js 的串行队列，和 TTS 排同一条队。
 * 任一步失败都抛 Error（带步骤名 + stderr 摘要），由工具层转成文字错误。
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureTempDir } from './media.js';
import { withGpu } from './gpu.js';
import { resolveVoiceRef } from './ttsvoice.js';
const SVS_PY = 'D:/NapCat/svs/.venv/Scripts/python.exe';
const SVS_SCRIPT = 'D:/NapCat/svs/sing.py';
const SVC_ROOT = 'D:/NapCat/svc';
const SVC_PY = SVC_ROOT + '/venv/Scripts/python.exe';
const SVC_DIR = SVC_ROOT + '/seed-vc';
const SVC_CKPT = SVC_DIR + '/checkpoints/DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth';
const SVC_CONFIG = SVC_DIR + '/checkpoints/config_dit_mel_seed_uvit_whisper_base_f0_44k.yml';
/**
 * 简谱文本 → sing.py 的 score 对象。
 * 三行：歌词 / 音高 / 时值（秒）；一行一个字对应一个音符，一字多音用 '|' 分组，
 * 空行和 # 开头的行忽略。也接受直接给 {"text","notes","durs"} 的 JSON。
 */
export function parseScore(raw) {
    const trimmed = String(raw ?? '').trim();
    if (trimmed === '')
        throw new Error('score 为空，没有可唱的内容');
    if (trimmed.startsWith('{')) {
        let cfg;
        try {
            cfg = JSON.parse(trimmed);
        }
        catch (error) {
            throw new Error('score 是 JSON 但解析失败：' + (error instanceof Error ? error.message : String(error)));
        }
        const value = cfg;
        if (typeof value?.text !== 'string' || typeof value?.notes !== 'string' || typeof value?.durs !== 'string') {
            throw new Error('score JSON 需要 text / notes / durs 三个字符串字段');
        }
        return { text: value.text.trim(), notes: value.notes.trim(), durs: value.durs.trim() };
    }
    const lines = trimmed.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'));
    if (lines.length < 3)
        throw new Error('score 需要三行：歌词 / 音高 / 时值（只收到 ' + lines.length + ' 行）');
    return { text: lines[0] ?? '', notes: lines[1] ?? '', durs: lines[2] ?? '' };
}
/** 唱一首歌，返回 { wav, audioSec }；串行占用显存，失败抛 Error。 */
export function synthesizeSing(scoreText, config, log) {
    return withGpu(() => singOnce(scoreText, config, log));
}
async function singOnce(scoreText, config, log) {
    const score = parseScore(scoreText);
    const dir = await ensureTempDir();
    const stem = 'sing-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const scorePath = join(dir, stem + '.json');
    const rawWav = join(dir, stem + '.wav');
    const vcDir = join(dir, stem + '-vc');
    const finalWav = join(dir, stem + '-sing.wav');
    const timeoutMs = Number(config.singTimeoutMs ?? 300000);
    const started = Date.now();
    const left = () => Math.max(1000, timeoutMs - (Date.now() - started));
    try {
        await writeFile(scorePath, JSON.stringify(score), 'utf8');
        log('debug', '唱歌：合成原唱 ' + score.text.length + ' 字');
        const tSvs = Date.now();
        const svs = await runStep('歌声合成', SVS_PY, [SVS_SCRIPT, '--score', scorePath, '--out', rawWav], {
            timeoutMs: left(),
            env: pythonEnv(),
        });
        const svsSec = (Date.now() - tSvs) / 1000;
        const matched = /"audio_sec":\s*([0-9.]+)/.exec(svs.stdout);
        const audioSec = matched?.[1] === undefined ? undefined : Number(matched[1]);
        const targetVoice = resolveVoiceRef(config);
        log('debug', '唱歌：音色转换 → ' + targetVoice);
        const tSvc = Date.now();
        await runStep('音色转换', SVC_PY, [
            'inference.py',
            '--source', rawWav,
            '--target', targetVoice,
            '--output', vcDir,
            '--diffusion-steps', '50', '--length-adjust', '1.0',
            '--inference-cfg-rate', '0.7',
            '--f0-condition', 'True', '--auto-f0-adjust', 'False', '--semi-tone-shift', '0',
            '--checkpoint', SVC_CKPT, '--config', SVC_CONFIG, '--fp16', 'True',
        ], {
            cwd: SVC_DIR,
            timeoutMs: left(),
            env: pythonEnv({
                PYTHONPATH: SVC_ROOT + '/shims',
                SEEDVC_LOCAL_MODELS: SVC_ROOT + '/models/raw',
                HF_HUB_OFFLINE: '1',
                TRANSFORMERS_OFFLINE: '1',
            }),
        });
        const svcSec = (Date.now() - tSvc) / 1000;
        // Seed-VC 输出名写死在 inference.py，只能扫目录（目录是这次新建的，只有一个 wav）
        const produced = (await readdir(vcDir)).filter(name => name.toLowerCase().endsWith('.wav'));
        if (produced.length === 0)
            throw new Error('音色转换没有产出 wav（输出目录为空）');
        if (produced.length > 1)
            log('warn', '音色转换产出多个 wav，取第一个：' + produced.join(', '));
        await rename(join(vcDir, produced[0] ?? ''), finalWav);
        const buffer = await readFile(finalWav);
        if (buffer.length < 44 || buffer.subarray(0, 4).toString('latin1') !== 'RIFF')
            throw new Error('音色转换产出的不是 wav（' + buffer.length + ' 字节）');
        log('debug', '唱歌完成：' + finalWav + '（' + (audioSec ?? '?') + 's 歌 / SVS ' + svsSec.toFixed(1) + 's + SVC ' + svcSec.toFixed(1) + 's）');
        return { wav: finalWav, audioSec, timings: { svsSec: Number(svsSec.toFixed(2)), svcSec: Number(svcSec.toFixed(2)) } };
    }
    finally {
        await rm(scorePath, { force: true }).catch(() => undefined);
        await rm(rawWav, { force: true }).catch(() => undefined);
        await rm(vcDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** Python 子进程环境：强制 utf-8，免得中文报错在 Windows 代码页里变乱码。 */
function pythonEnv(extra = {}) {
    return { ...process.env, PYTHONIOENCODING: 'utf-8', ...extra };
}
/** 跑一步命令，收尾时保留输出尾部（sing.py 的 JSON 结果在最后一行）。 */
function runStep(step, bin, args, options) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, args, {
                cwd: options.cwd,
                env: options.env ?? process.env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (error) {
            reject(new Error(step + ' 启动失败：' + messageOf(error)));
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error === undefined)
                resolve(value ?? { stdout, stderr });
            else
                reject(error);
        };
        timer = setTimeout(() => {
            child.kill(); // 只杀直接子进程；python 自己不派生长命子进程
            finish(new Error(step + '超时（>' + options.timeoutMs + 'ms），已杀掉进程'));
        }, options.timeoutMs);
        child.stdout.on('data', chunk => { stdout = keepTail(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = keepTail(stderr, chunk); });
        child.on('error', error => finish(new Error(step + ' 启动失败：' + messageOf(error))));
        child.on('close', code => {
            if (code === 0)
                finish(undefined, { stdout, stderr });
            else
                finish(new Error(step + '失败（退出码 ' + String(code) + '）：' + summarize(stderr, stdout)));
        });
    });
}
function keepTail(acc, chunk) {
    const text = acc + String(chunk);
    return text.length > 20000 ? text.slice(-20000) : text;
}
/** 报错用摘要：优先 stderr，取最后几行有内容的。 */
function summarize(stderr, stdout) {
    const text = stderr.trim() !== '' ? stderr.trim() : stdout.trim();
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
    return (lines.length === 0 ? '(无输出)' : lines.slice(-5).join(' | ')).slice(-500);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
