/**
 * 音色预设：运行时切换 + 解析实际参考音频。
 *
 * 优先级：运行时覆盖 > ttsVoices[ttsVoice] > ttsVoiceRef（旧配置兜底）。
 * 「原版」必须用 original_ref.wav：服务端 legacy 名单会把 u3.wav 强制映射成银月。
 */
import type { Config } from './config.js';
export declare function setVoiceOverride(name: string): void;
/** 测试用：清掉运行时覆盖。 */
export declare function resetVoiceOverride(): void;
/** 当前音色名：运行时覆盖命中预设优先，否则用配置的 ttsVoice。 */
export declare function currentVoiceName(config: Config): string;
/** 合成实际用的参考音频路径：覆盖 > 预设 > 旧的 ttsVoiceRef。 */
export declare function resolveVoiceRef(config: Config): string;
