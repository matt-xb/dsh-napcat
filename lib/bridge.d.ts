/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { LogLevel, OneBotConnection } from './onebot.js';
import type { ObEvent } from './types.js';
export interface BridgeOptions {
    ctx: Context;
    config: Config;
    conn: OneBotConnection;
    log(level: LogLevel, message: string): void;
}
export declare class Bridge {
    private readonly opts;
    private readonly chats;
    private readonly bySession;
    /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
    private readonly sessionSuffixes;
    private sessionEventOff;
    private stopped;
    private mentionWarned;
    constructor(opts: BridgeOptions);
    start(): void;
    stop(): Promise<void>;
    /** 一条 OneBot 事件进站。 */
    handleEvent(event: ObEvent): Promise<void>;
    private ensureChat;
    /** 会话工作目录：开了 perChatWorkspace 时每个 QQ 会话一个子目录（侧边栏按工作区归拢）。 */
    private cwdFor;
    private dispatch;
    /** 10s 内没等到 turn/start 就认为会话已失效（典型：会话被归档），换新会话重投一次。 */
    private armWatchdog;
    /** 会话失效后：重建会话并把这条消息再投一次（每条消息只重试一次）。 */
    private recoverAndRetry;
    /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
    private recoverChat;
    private onSessionEvent;
    /** 按 splitMaxChars 分段发送（第一段可带引用）。 */
    private sendText;
}
