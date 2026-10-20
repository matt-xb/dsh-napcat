/** 消息段 → 纯文本、@ 判定、长文分段。 */
import type { ObMessage, ObSegment } from './types.js';
/** 解析 CQ 码字符串（NapCat 配成字符串上报时的兜底；数组更常见）。 */
export declare function parseCq(raw: string): ObSegment[];
/** 归一化成消息段数组。 */
export declare function segmentsOf(message: ObMessage | undefined): ObSegment[];
/** 把消息段拼成给模型看的纯文本（图片/语音等转成占位符）。 */
export declare function toText(message: ObMessage | undefined, selfId?: string, selfName?: string): string;
/** 是否 @ 了指定 QQ（群聊门控用）。 */
export declare function mentions(message: ObMessage | undefined, selfId: string): boolean;
/** 是否引用了指定消息（回复机器人的消息也算"提及"，由调用方决定是否启用）。 */
export declare function repliesTo(message: ObMessage | undefined, messageId: string): boolean;
/**
 * 长文分段：优先按空行切，其次按句号/换行，最后硬切。
 * 返回的每段都不超过 maxChars（maxChars <= 0 时原样返回一段）。
 */
export declare function splitText(text: string, maxChars: number): string[];
