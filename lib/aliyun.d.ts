/**
 * 阿里云百炼（DashScope）云端语音：识别用 qwen3-asr-flash，合成用 qwen3-tts-flash。
 *
 * 不引 SDK：两条都是普通 HTTPS POST，用原生 fetch。云端只做「听」和「嘴」的替代实现，
 * 上层（bridge 的 [语音] 回退、napcat_send_voice 的失败回退文字）完全不用改。
 * 失败一律抛错（识别）或返回 null（合成），不自动降级去拉本机 whisper / IndexTTS。
 */
import type { Config } from './config.js';
import type { LogLevel } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** 测试注入点：默认用全局 fetch。 */
export interface AliyunDeps {
    fetch?: typeof fetch;
}
/** 模型是否支持情感标签与 instruction。 */
export declare function supportsEmotionTag(model: unknown): boolean;
/** 情绪名 → 官方标签；不认识或平静时返回空串。 */
export declare function emotionTag(emotion: unknown): string;
/**
 * 把情绪标签插到文本开头；已带官方标签时原样返回（幂等）。
 * 注意标签本身也计入 600 字上限，所以拼接顺序是「先标签后正文」。
 */
export declare function applyEmotionTag(text: string, emotion: unknown): string;
/** 语音 → 文本。失败抛错，由调用方回退 [语音]。 */
export declare function transcribeAliyun(wav: Buffer, config: Config, log: Log, deps?: AliyunDeps): Promise<string>;
/** 文本 → 临时 wav 路径；失败返回 null（不抛）。 */
export declare function synthesizeAliyun(text: string, config: Config, log: Log, deps?: AliyunDeps): Promise<string | null>;
export {};
