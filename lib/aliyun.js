/**
 * 阿里云百炼（DashScope）云端语音：识别用 qwen3-asr-flash，合成用 qwen3-tts-flash。
 *
 * 不引 SDK：两条都是普通 HTTPS POST，用原生 fetch。云端只做「听」和「嘴」的替代实现，
 * 上层（bridge 的 [语音] 回退、napcat_send_voice 的失败回退文字）完全不用改。
 * 失败一律抛错（识别）或返回 null（合成），不自动降级去拉本机 whisper / IndexTTS。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureTempDir } from './media.js';
/** 官方域名；换成地域化工作空间域名时改这里的默认值即可。 */
const BASE_URL = 'https://dashscope.aliyuncs.com';
const ASR_PATH = '/compatible-mode/v1/chat/completions';
/** qwen3-tts-flash 走多模态端点。 */
const TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
/** Qwen-Audio-TTS（qwen-audio-3.x-tts-*）走独立合成端点，两条互不通用。 */
const TTS_AUDIO_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';
/** qwen3-tts-flash 单次文本上限（官方限制），超了不截断，直接让调用方回退文字。 */
const MAX_TTS_CHARS = 600;
/** Qwen-Audio-TTS 系列：支持情感标签与 instruction，端点和音色后缀都和别人不同。 */
const AUDIO_TTS_RE = /^qwen-audio-\d+(?:\.\d+)?-tts-/i;
/**
 * 八维情绪 → 官方情感标签（仅 Qwen-Audio-TTS 系列，写进 text 开头）。
 * calm 刻意不给标签：平静就该是自然语气，硬加一个标签反而会被读成某种腔调。
 * 键与 tts.ts 的 EMOTIONS 完全对齐（英文名 + 中文别名）。
 */
const EMOTION_TAGS = {
    happy: '[excited]',
    angry: '[angry]',
    sad: '[sad]',
    afraid: '[trembling]',
    disgusted: '[scornful]',
    melancholic: '[bored]',
    surprised: '[amazed]',
    calm: '',
    '高兴': '[excited]',
    '生气': '[angry]',
    '难过': '[sad]',
    '害怕': '[trembling]',
    '嫌弃': '[scornful]',
    '没劲': '[bored]',
    '惊讶': '[amazed]',
    '平静': '',
};
/** 官方控制类 + 富语言类标签全集：用于判断文本里是否已经带了标签（幂等）。 */
const KNOWN_TAGS = new Set([
    'sad', 'amazed', 'deep and loud shouting', 'trembling', 'angry', 'excited', 'sarcastic',
    'curious', 'like dracula', 'bored', 'tired', 'scornful', 'shouting', 'asmr', 'panicked',
    'mischievously', 'empathetic', 'whispers', 'reluctantly', 'crying', 'serious',
    'very slowly', 'very fast', 'gasp', 'sighing', 'clears throat', 'giggles', 'laughing',
    'cough', 'snorts',
]);
const ANY_TAG_RE = /\[([^\[\]]{1,40})\]/g;
/** 模型是否支持情感标签与 instruction。 */
export function supportsEmotionTag(model) {
    return AUDIO_TTS_RE.test(String(model ?? '').trim());
}
/** 情绪名 → 官方标签；不认识或平静时返回空串。 */
export function emotionTag(emotion) {
    const raw = String(emotion ?? '').trim();
    if (raw === '')
        return '';
    return EMOTION_TAGS[raw.toLowerCase()] ?? EMOTION_TAGS[raw] ?? '';
}
/** 文本里已有的情感标签数（只认官方标签，免得把普通方括号当成标签）。 */
function countKnownTags(text) {
    let found = 0;
    for (const match of text.matchAll(ANY_TAG_RE)) {
        if (KNOWN_TAGS.has(String(match[1]).trim().toLowerCase()))
            found += 1;
    }
    return found;
}
/**
 * 把情绪标签插到文本开头；已带官方标签时原样返回（幂等）。
 * 注意标签本身也计入 600 字上限，所以拼接顺序是「先标签后正文」。
 */
export function applyEmotionTag(text, emotion) {
    const tag = emotionTag(emotion);
    if (tag === '' || countKnownTags(text) > 0)
        return text;
    return tag + text;
}
/** 音色与模型明显错配时提个醒（不拦请求，官方错报比本地猜更准）。 */
function warnVoiceMismatch(model, voice, log) {
    const audioTts = supportsEmotionTag(model);
    const hasSuffix = /_v\d/i.test(voice);
    if (audioTts && !hasSuffix) {
        log('warn', '音色 ' + voice + ' 与模型 ' + model + ' 可能不匹配：Qwen-Audio-TTS 的系统音色带 _v3.1 后缀，如 longanhuan_v3.1');
    }
    else if (!audioTts && hasSuffix) {
        log('warn', '音色 ' + voice + ' 与模型 ' + model + ' 可能不匹配：带 _v3 后缀的音色属于 Qwen-Audio-TTS');
    }
}
/** 语音 → 文本。失败抛错，由调用方回退 [语音]。 */
export async function transcribeAliyun(wav, config, log, deps = {}) {
    const key = String(config.aliyunApiKey ?? '').trim();
    if (key === '')
        throw new Error('阿里云识别未配置 aliyunApiKey');
    const body = {
        model: String(config.aliyunAsrModel ?? '').trim() || 'qwen3-asr-flash',
        messages: [{
                role: 'user',
                content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wav.toString('base64') } }],
            }],
        stream: false,
        asr_options: { enable_itn: false },
    };
    const json = await postJson(ASR_PATH, key, body, config.voiceTimeoutMs, deps);
    const text = String(json?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim();
    if (text === '')
        throw new Error('阿里云识别没有返回文字');
    log('debug', '语音转写（阿里云）: ' + text);
    return text;
}
/** 文本 → 临时 wav 路径；失败返回 null（不抛）。 */
export async function synthesizeAliyun(text, config, log, deps = {}) {
    const key = String(config.aliyunApiKey ?? '').trim();
    if (key === '') {
        log('warn', '阿里云合成未配置 aliyunApiKey，跳过: ' + text.slice(0, 20));
        return null;
    }
    // 情绪标签是拼在正文前面的，所以上限按「标签 + 正文」算。
    const model = String(config.aliyunTtsModel ?? '').trim() || 'qwen3-tts-flash';
    const emotionSupport = supportsEmotionTag(model);
    const tagged = emotionSupport ? applyEmotionTag(text, config.ttsEmotion) : text;
    if (tagged.length > MAX_TTS_CHARS) {
        // shortcut: 一次只合成 600 字以内，超长不回退本机 TTS（这台机器没装），交给上层改发文字。
        log('warn', '云端合成单次上限 ' + MAX_TTS_CHARS + ' 字符，本次 ' + tagged.length + ' 字，跳过');
        return null;
    }
    try {
        const voice = String(config.aliyunTtsVoice ?? '').trim() || 'Cherry';
        warnVoiceMismatch(model, voice, log);
        const body = emotionSupport
            ? audioTtsBody(model, tagged, voice, config)
            : { model, input: { text: tagged, voice, language_type: 'Chinese' } };
        const json = await postJson(emotionSupport ? TTS_AUDIO_PATH : TTS_PATH, key, body, config.ttsTimeoutMs, deps);
        const audio = json?.output?.audio;
        const url = String(audio?.url ?? '').trim();
        const inline = String(audio?.data ?? '').trim();
        const buffer = url !== ''
            ? await fetchAudio(url, config.ttsTimeoutMs, deps)
            : Buffer.from(inline, 'base64');
        if (buffer.length === 0)
            throw new Error('云端合成没有返回音频');
        const dir = await ensureTempDir();
        const ext = buffer.subarray(0, 4).toString('latin1') === 'RIFF' ? '.wav' : '.mp3';
        const wav = join(dir, 'tts-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext);
        await writeFile(wav, buffer);
        log('debug', 'TTS 合成（阿里云）: ' + text.slice(0, 20) + ' → ' + wav);
        return wav;
    }
    catch (error) {
        log('warn', '云端合成失败（' + (error instanceof Error ? error.message : String(error)) + '）: ' + text.slice(0, 20));
        return null;
    }
}
/** Qwen-Audio-TTS 的请求体：没有 language_type，改用 format/sample_rate，可按需带 instruction。 */
function audioTtsBody(model, text, voice, config) {
    const input = { text, voice, format: 'wav', sample_rate: 24000 };
    const instruction = String(config.aliyunTtsInstruction ?? '').trim();
    if (instruction !== '')
        input.instruction = instruction;
    return { model, input };
}
async function postJson(path, key, body, timeoutMs, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000);
    try {
        const response = await (deps.fetch ?? fetch)(BASE_URL + path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        }
        catch {
            throw new Error('HTTP ' + response.status + '：返回不是 JSON');
        }
        if (!response.ok)
            throw new Error('HTTP ' + response.status + '：' + describeError(json));
        return json;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchAudio(url, timeoutMs, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000);
    try {
        const response = await (deps.fetch ?? fetch)(url, { signal: controller.signal });
        if (!response.ok)
            throw new Error('下载合成音频失败 HTTP ' + response.status);
        return Buffer.from(await response.arrayBuffer());
    }
    finally {
        clearTimeout(timer);
    }
}
/** 百炼的错通常放在 code/message（有时还有 output.message），捞出来给日志看。 */
function describeError(json) {
    const value = json;
    const code = String(value?.code ?? '').trim();
    const message = String(value?.message ?? value?.output?.message ?? '').trim();
    if (code === '' && message === '')
        return '未知错误';
    return (code === '' ? '' : code + '：') + message;
}
