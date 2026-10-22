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
    /** sessionId → 该会话的人设文本（来自 personaOverrides）。 */
    private readonly personaBySession;
    /** 解析后的人设表（chat key → 文本）。 */
    private personas;
    private sessionEventOff;
    private stopped;
    private mentionWarned;
    constructor(opts: BridgeOptions);
    start(): void;
    stop(): Promise<void>;
    /** 一条 OneBot 事件进站。 */
    handleEvent(event: ObEvent): Promise<void>;
    /** 写一行诊断到 <会话cwd>/napcat-inbox/_image-debug.log（出问题时能自查，用户随时可删）。 */
    private debugLog;
    /** 宿主会话 id → QQ 会话 key（工具省略 chat_id 时用来定位当前会话）。 */
    keyForSession(sessionId: string): string | undefined;
    /** 把消息里的图片/文件下载到会话收件箱，返回给模型的文本注释（[图片: path]）。 */
    private resolveInboundMedia;
    /** 同一聊天并发进来时只装配一次（并发 create 会撞 write handle）。 */
    private readonly pendingChats;
    private ensureChat;
    private createChat;
    /**
     * 把会话挂进工作区：宿主要求 **工作区路径必须等于会话 cwd**，所以每个聊天目录本身就是
     * 一个工作区（一群一格 / 一人一格）。照 dsh-onebot：resolveByPath → create(path,title) → attachSession。
     */
    /** 该会话是否已被归档（归档门禁会把每一轮判成 blocked，所以要换新会话）。 */
    private isArchived;
    /** 重新解析 personaOverrides（配置热更新时调用）。 */
    refreshPersonas(): void;
    /** systemPrompt.context 的取值函数：按 assembly 里的 sessionId 找该会话的人设。 */
    personaText(assembly: {
        agent?: {
            session?: {
                id?: unknown;
            };
        };
    } | undefined): string;
    private attachToWorkspace;
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
