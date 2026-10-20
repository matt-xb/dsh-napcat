/** 会话标识、准入策略、session id 派生。 */
import type { Config } from './config.js';
import type { ObMessageEvent } from './types.js';
export type ChatKind = 'private' | 'group';
export interface ChatRef {
    kind: ChatKind;
    id: string;
    key: string;
}
/** 从消息事件算出会话（私聊=用户 QQ，群聊=群号）。 */
export declare function chatRefOf(event: ObMessageEvent): ChatRef | undefined;
export declare function isAdmin(config: Config, userId: string): boolean;
/** 这个会话/发送方是否允许进入模型（返回 false 时静默丢弃，只打 debug 日志）。 */
export declare function allowAccess(config: Config, chat: ChatRef, userId: string): boolean;
/**
 * 每个 QQ 会话一个稳定的 session id：
 * 重启后 create 会因同 id 的已持久化日志而失败，Bridge 会回退到 resume，
 * 于是同一 QQ 会话自然续上原来的上下文。
 */
export declare function sessionIdForChat(key: string): string;
