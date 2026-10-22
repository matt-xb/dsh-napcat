/** 群/私聊记忆：一群一目录隔离 + 最近消息缓冲；长期记忆走 mnemon（失败则落本地 notes.md）。 */
import type { LogLevel } from './onebot.js';
export interface MemoryOptions {
    ctx: unknown;
    /** 记忆根目录（通常是 <workspacePath>/memory） */
    root: string;
    /** mnemon 空间名前缀 */
    spacePrefix: string;
    /** 长期记忆后端：mnemon（每群一空间）或 file（纯本地） */
    backend: 'mnemon' | 'file';
    /** recent.jsonl 保留条数 */
    recentLimit: number;
    /** 注入最近多少条对话 */
    injectRecent: number;
    /** 注入总字符上限 */
    injectMaxChars: number;
    log: (level: LogLevel, message: string) => void;
}
export interface ChatLike {
    agent?: unknown;
}
export declare class MemoryStore {
    private readonly opts;
    constructor(opts: MemoryOptions);
    /** 每个聊天一个目录：memory/group-<号> / memory/private-<QQ> */
    private dirFor;
    private ensureDir;
    /** 用注册表直接调工具（插件掌握时机，不依赖模型）。 */
    private callTool;
    /** 记忆相关失败：warn 到控制台 + 追加到 memory/_debug.log，便于事后定位。 */
    private reportFailure;
    /** 拿到（或创建）本聊天的 mnemon 空间 id；失败返回 undefined（自动退化为文件记忆）。 */
    ensureSpace(chatKey: string, agent: unknown): Promise<string | undefined>;
    /** 写一条长期记忆：优先 mnemon，失败落 notes.md。 */
    remember(chatKey: string, content: string, agent: unknown, tags?: readonly string[]): Promise<string>;
    /** 召回与本群相关的内容（query 用最近对话摘要）。 */
    recall(chatKey: string, query: string, agent: unknown): Promise<string>;
    /** 追加一条最近消息（滚动保留）。 */
    appendRecent(chatKey: string, entry: {
        nick: string;
        text: string;
        at?: number;
    }): Promise<void>;
    /** 预热：用历史消息覆盖 recent（调用方判断缓冲是否不足）。 */
    seedRecent(chatKey: string, entries: Array<{
        nick: string;
        text: string;
        at?: number;
    }>): Promise<number>;
    /** 缓冲里最新一条的时间戳（毫秒；空=0）。用于判断缓冲是否"过期"。 */
    recentNewestAt(chatKey: string): Promise<number>;
    /** 当前缓冲条数（用于判断是否需要预热）。 */
    recentCount(chatKey: string): Promise<number>;
    /** 读最近 N 条，返回「昵称: 内容」行。 */
    readRecent(chatKey: string, limit?: number): Promise<string[]>;
    /** 组装注入文本（含 @ 优先级指令），超预算截断。 */
    buildInjection(parts: {
        chatKey: string;
        recent: readonly string[];
        recallText?: string;
        mention?: string;
    }): string;
}
