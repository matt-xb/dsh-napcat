/**
 * 文字转语音（"嘴"）：合成 wav，供 napcat_send_voice 发 record 段。
 *
 * 后端两选一（config.voiceTtsProvider）：本机 IndexTTS 服务（HTTP），或阿里云百炼 qwen3-tts-flash。
 * 不引第三方依赖：本地直接 fetch /tts，云端用原生 fetch。任何一步失败都返回 null 并记日志，由调用方降级。
 * 本机服务没起来（ECONNREFUSED / fetch failed）时自动拉起一次，等 /health 就绪后重试一次。
 */
import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import type { LogLevel } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** 情绪名 → 八维向量；也接受已经写好的 "0,0,...,1" 逗号串。非法值返回 undefined。 */
export declare function emotionVector(emotion: unknown): string | undefined;
/** 测试注入点：默认全用真实实现。 */
export interface TtsDeps {
    fetch?: typeof fetch;
    spawn?: typeof spawn;
    exists?: (path: string) => boolean;
    sleep?: (ms: number) => Promise<void>;
    logFile?: string;
}
/** 测试用：清掉拉起单例（生产代码不需要调用）。 */
export declare function resetTtsAutoStart(): void;
/** 合成一段语音到临时 wav，返回绝对路径；失败/超时返回 null（不抛）。 */
export declare function synthesizeToWav(text: string, config: Config, log: Log, deps?: TtsDeps, chatKey?: string): Promise<string | null>;
/** 服务没起时拉起并等就绪；同一时刻只跑一次（并发请求共用同一个 Promise）。失败后放开，下次请求可再试。 */
export declare function ensureTtsServer(config: Config, log: Log, deps?: TtsDeps): Promise<boolean>;
export {};
