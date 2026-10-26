/**
 * 文字转语音（"嘴"）：本机 IndexTTS 服务（HTTP）合成 wav，供 napcat_send_voice 发 record 段。
 *
 * 不引第三方依赖：直接 fetch 本地 /tts。任何一步失败都返回 null 并记日志，由调用方降级。
 */
import type { Config } from './config.js';
import type { LogLevel } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** 情绪名 → 八维向量；也接受已经写好的 "0,0,...,1" 逗号串。非法值返回 undefined。 */
export declare function emotionVector(emotion: unknown): string | undefined;
/** 合成一段语音到临时 wav，返回绝对路径；失败/超时返回 null（不抛）。 */
export declare function synthesizeToWav(text: string, config: Config, log: Log): Promise<string | null>;
export {};
