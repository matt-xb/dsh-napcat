/**
 * 语音转文字（"耳朵"）：QQ 语音段 → OneBot get_record（服务端转 wav）→ 文本。
 *
 * 识别后端两选一（config.voiceAsrProvider）：本机 whisper.cpp 子进程，或阿里云百炼 qwen3-asr-flash。
 * 不引第三方依赖：转码用 NapCat 自带的 ffmpeg addon（get_record 的 out_format）。
 * 任何一步失败都抛错，由调用方回退 [语音] 占位符；云端失败不会偷偷改跑本机模型。
 */
import type { Config } from './config.js';
import type { LogLevel, OneBotConnection } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** 测试注入点：云端识别用的 fetch，默认全局 fetch。 */
export interface VoiceDeps {
    fetch?: typeof fetch;
}
/** 把一条语音转成文本；失败/超时直接抛错。调用方负责兜底。 */
export declare function transcribeRecord(conn: OneBotConnection, fileRef: string, config: Config, log: Log, deps?: VoiceDeps): Promise<string>;
export {};
