/**
 * 语音转文字（"耳朵"）：QQ 语音段 → OneBot get_record（服务端转 wav）→ whisper.cpp 出文本。
 *
 * 不引第三方依赖：转码用 NapCat 自带的 ffmpeg addon（get_record 的 out_format），
 * 识别用本机 whisper-cli 子进程。任何一步失败都抛错，由调用方回退 [语音] 占位符。
 */
import type { Config } from './config.js';
import type { LogLevel, OneBotConnection } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** 把一条语音转成文本；失败/超时直接抛错。调用方负责兜底。 */
export declare function transcribeRecord(conn: OneBotConnection, fileRef: string, config: Config, log: Log): Promise<string>;
export {};
