/**
 * OneBot 11 WebSocket 连接层。
 *
 * - forward：本插件作为客户端连 NapCat 的 ws（NapCat 在云服务器上时用这个）
 * - reverse：本插件起 ws 服务端，NapCat 的「反向 WebSocket」拨进来
 *
 * 两种模式的上行/下行 JSON 完全一致：
 *   上行（NapCat → 本插件）：事件 { post_type: 'message' | 'meta_event' | ... }
 *   下行（本插件 → NapCat）：动作 { action: 'send_msg', params: {...}, echo: '<id>' }
 *   动作回执：{ status: 'ok' | 'failed', retcode, data, echo }  —— 用 echo 对上号
 */
import type { ObEvent } from './types.js';
export type LogLevel = 'debug' | 'info' | 'warn';
export interface OneBotOptions {
    mode: 'forward' | 'reverse';
    /** forward 目标地址。 */
    url: string;
    /** reverse 监听地址/端口。 */
    host: string;
    port: number;
    accessToken: string;
    reconnectMaxAttempts: number;
    log(level: LogLevel, message: string): void;
    onEvent(event: ObEvent): void;
    onStatus(connected: boolean): void;
}
/** OneBot 11 连接（forward 客户端 / reverse 服务端二选一，由 mode 决定）。 */
export declare class OneBotConnection {
    private readonly opts;
    /** 机器人自己的 QQ（从 meta 事件或 get_login_info 学到）。 */
    selfId: string;
    private socket;
    private server;
    private readonly pending;
    private attempts;
    private stopped;
    private reconnectTimer;
    /** 上一次连接错误（用于把"为什么没连上"合并进一条日志）。 */
    private lastError;
    /** url 为空的提示只打一次。 */
    private missingUrlWarned;
    /** 只在连接状态真正变化时上报，避免每次重试都刷"通道断开"。 */
    private wasConnected;
    constructor(opts: OneBotOptions);
    get connected(): boolean;
    start(): void;
    stop(): Promise<void>;
    /**
     * 调用一个 OneBot 动作并等待回执。
     * @throws 未连接 / 超时 / 对端返回 failed
     */
    call<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    private connect;
    /** 退避重连；日志限流：前 3 次 + 每 10 次一条，其余降到 debug。 */
    private scheduleReconnect;
    private startServer;
    private dropSocket;
    private onMessage;
    /** 学到机器人自己的 QQ（配置留空时用于 @ 门控与自消息过滤）。 */
    private learnSelfId;
}
