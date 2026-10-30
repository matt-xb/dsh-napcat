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
/** 在文本里找第一个命中的触发关键字（大小写不敏感，空词忽略）。 */
export declare function findKeyword(text: string, words: readonly string[]): string | undefined;
/** 去掉命中的触发关键字（大小写不敏感，只去掉第一个）。 */
export declare function stripKeyword(text: string, keyword: string): string;
/** 消息是否引用了这批消息 id 中的任意一条。 */
export declare function repliesToAny(message: ObMessage | undefined, ids: readonly string[]): boolean;
/** 稳定的短哈希（djb2 → base36），用于把 cwd 编进会话 id。 */
export declare function shortHash(text: string): string;
/**
 * 解析「群/人性格」配置：每行 `<group:群号|private:QQ>=<人设文本>`，
 * 支持 `#` 注释与空行。返回 key → 文本（key 形如 `group:123`）。
 */
export declare function parsePersonaOverrides(raw: string): Map<string, string>;
/** 正文里出现内部上下文标记：整条都不能发（半截裁剪会留下残句，比不发更糟）。 */
export declare function looksLikeInternalContext(text: string): boolean;
/**
 * 出口硬拦：待发正文和「本轮注入给模型的原文」重合太多，就是复述，整条丢弃。
 * 注入原文由 bridge 记录（宿主 runtime-context 的 snapshot sections + 插件规则段 + 入站上下文块）；
 * 拿不到原文时（例如工具直接发别的聊天）仍有 `looksLikeInternalContext` 这层关键词兜底。
 * 判据用足够长的连续片段，正常聊天里复述用户自己的话不会命中。
 */
export declare function replaysInjected(text: string, injected: readonly string[]): boolean;
/** Internal context must never be forwarded to QQ. */
export declare function sanitizeReply(text: string): string | null;
/** Compact short Chinese prose only; preserve structured and long-form output. */
export declare function compactShortReply(text: string): string;
/** Same-turn comparison only; preserve numbers, code and emotional punctuation. */
export declare function replyDedupKey(text: string): string;
/** Tool and automatic sends share this wire boundary. */
export declare function sanitizeOutgoingMessage(message: unknown): ObMessage;
/** 会话标题：`MM-DD HH:mm`（本地时间；内容容易乱，所以只标时间）。 */
export declare function titleFrom(text: string, now?: Date): string;
/** 文件名模糊匹配打分（0 = 不匹配）。用户常只记得一部分名字。 */
export declare function scoreFileName(name: string, query: string): number;
/** 按模糊打分排序候选（只返回 score>0）。 */
export declare function rankByFileName<T>(items: readonly T[], query: string, nameOf: (item: T) => string): Array<{
    item: T;
    score: number;
}>;
