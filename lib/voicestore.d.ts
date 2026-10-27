import type { Config } from './config.js';
import type { LogLevel } from './onebot.js';
type Log = (level: LogLevel, message: string) => void;
/** 文件名（与 memory 根同一个基准：workspacePath）。 */
export declare const VOICE_STORE_FILE = "voice-presets.json";
/** 确保内存表已按当前 workspacePath 读过一次盘。 */
export declare function loadVoiceStore(config: Config, log?: Log): Promise<void>;
/** 读某个会话当前的音色（内存；调之前由 loadVoiceStore 懒加载）。 */
export declare function getStoredVoice(chatKey: string): string | undefined;
/** 整表写盘：先写 .tmp 再 rename。失败只 warn（内存里已经生效）。 */
export declare function saveVoiceStore(config: Config, log: Log, map: Map<string, string>): Promise<void>;
/** 设定某个会话的音色并落盘（先懒加载，免得把别的会话覆盖冲掉）。 */
export declare function setStoredVoice(config: Config, log: Log, chatKey: string, name: string): Promise<void>;
/** 测试用：清内存缓存；下次 get/set 会重新读盘。 */
export declare function resetVoiceStore(): void;
export {};
