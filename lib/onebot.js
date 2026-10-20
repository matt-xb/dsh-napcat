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
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
const CALL_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** OneBot 11 连接（forward 客户端 / reverse 服务端二选一，由 mode 决定）。 */
export class OneBotConnection {
    opts;
    /** 机器人自己的 QQ（从 meta 事件或 get_login_info 学到）。 */
    selfId = '';
    socket;
    server;
    pending = new Map();
    attempts = 0;
    stopped = false;
    reconnectTimer;
    /** 上一次连接错误（用于把"为什么没连上"合并进一条日志）。 */
    lastError = '';
    /** url 为空的提示只打一次。 */
    missingUrlWarned = false;
    /** 只在连接状态真正变化时上报，避免每次重试都刷"通道断开"。 */
    wasConnected = false;
    constructor(opts) {
        this.opts = opts;
    }
    get connected() {
        return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
    }
    start() {
        this.stopped = false;
        if (this.opts.mode === 'reverse')
            this.startServer();
        else
            this.connect();
    }
    async stop() {
        this.stopped = true;
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        for (const [echo, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('connection stopped'));
            this.pending.delete(echo);
        }
        const server = this.server;
        this.server = undefined;
        if (server !== undefined) {
            await new Promise(resolve => server.close(() => resolve()));
        }
        this.dropSocket();
    }
    /**
     * 调用一个 OneBot 动作并等待回执。
     * @throws 未连接 / 超时 / 对端返回 failed
     */
    async call(action, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
        const socket = this.socket;
        if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
            throw new Error('NapCat 未连接（检查 mode/url/token 与 NapCat 的 ws 是否在监听）');
        }
        const echo = randomUUID();
        const payload = JSON.stringify({ action, params, echo });
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error('OneBot 动作超时: ' + action));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(echo, {
                resolve: value => resolve(value),
                reject,
                timer,
            });
        });
        socket.send(payload, error => {
            if (error !== undefined && error !== null) {
                const pending = this.pending.get(echo);
                if (pending !== undefined) {
                    clearTimeout(pending.timer);
                    this.pending.delete(echo);
                    pending.reject(error);
                }
            }
        });
        return promise;
    }
    // ── forward ────────────────────────────────────────────────────────────────
    connect() {
        if (this.stopped)
            return;
        const url = this.opts.url.trim();
        if (url === '') {
            if (!this.missingUrlWarned) {
                this.missingUrlWarned = true;
                this.opts.log('info', '未配置 NapCat 地址（url 为空），暂不连接；打开「设置 → 插件 → NapCat」填写地址和 Token 后会自动开始连接');
            }
            return;
        }
        const headers = {};
        if (this.opts.accessToken !== '')
            headers.authorization = 'Bearer ' + this.opts.accessToken;
        this.opts.log('debug', 'connecting to ' + url);
        const socket = new WebSocket(url, { headers });
        this.socket = socket;
        socket.on('open', () => {
            this.attempts = 0;
            this.lastError = '';
            this.opts.log('info', 'NapCat 已连接: ' + url);
            this.wasConnected = true;
            this.opts.onStatus(true);
            void this.learnSelfId();
        });
        socket.on('message', (data) => this.onMessage(data));
        socket.on('error', (error) => {
            // 连接错误由 close 统一处理并合并成一条日志，这里只记下原因。
            this.lastError = error.message;
        });
        socket.on('close', () => {
            if (this.socket !== socket)
                return;
            this.socket = undefined;
            if (this.wasConnected) {
                this.wasConnected = false;
                this.opts.onStatus(false);
            }
            if (this.stopped)
                return;
            this.scheduleReconnect();
        });
    }
    /** 退避重连；日志限流：前 3 次 + 每 10 次一条，其余降到 debug。 */
    scheduleReconnect() {
        const max = this.opts.reconnectMaxAttempts;
        this.attempts += 1;
        if (max > 0 && this.attempts > max) {
            this.opts.log('warn', '连续 ' + this.attempts + ' 次连不上 NapCat，已放弃重连（reconnectMaxAttempts=' + max + '）；改配置后重启插件即可恢复');
            return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempts - 1, 5));
        const loud = this.attempts <= 3 || this.attempts % 10 === 0;
        const reason = this.lastError === '' ? '' : '（' + this.lastError + '）';
        const line = '连不上 NapCat' + reason + '，' + Math.round(delay / 1000) + 's 后重试（第 ' + this.attempts + ' 次）';
        this.opts.log(loud ? 'warn' : 'debug', line);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }
    // ── reverse ────────────────────────────────────────────────────────────────
    startServer() {
        this.opts.log('info', '反向 WS 监听 ws://' + this.opts.host + ':' + this.opts.port + '（NapCat 的「WebSocket 反向」拨进来）');
        const server = new WebSocketServer({ host: this.opts.host, port: this.opts.port });
        this.server = server;
        server.on('listening', () => {
            this.opts.log('info', '反向 WS 已监听 :' + this.opts.port);
        });
        server.on('error', (error) => {
            this.opts.log('warn', '反向 WS 服务错误: ' + error.message);
        });
        server.on('connection', (socket, req) => {
            const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
            if (this.opts.accessToken !== '' && provided !== this.opts.accessToken) {
                this.opts.log('warn', '拒绝了一个 token 不匹配的反向 WS 连接（来自 ' + (req.socket.remoteAddress ?? '?') + '）');
                socket.close(1008, 'invalid token');
                return;
            }
            // 后到者接管：旧连接直接断开，避免双活造成重复回复。
            if (this.socket !== undefined && this.socket !== socket) {
                this.opts.log('warn', '新的反向 WS 连接到达，断开旧连接');
                this.dropSocket();
            }
            this.socket = socket;
            this.opts.log('info', 'NapCat 反向 WS 已接入（来自 ' + (req.socket.remoteAddress ?? '?') + '）');
            this.opts.onStatus(true);
            void this.learnSelfId();
            socket.on('message', (data) => this.onMessage(data));
            socket.on('close', () => {
                if (this.socket !== socket)
                    return;
                this.socket = undefined;
                this.opts.onStatus(false);
                this.opts.log('warn', 'NapCat 反向 WS 断开，等待重新接入');
            });
            socket.on('error', (error) => {
                this.opts.log('warn', '反向 WS 连接错误: ' + error.message);
            });
        });
    }
    // ── shared ─────────────────────────────────────────────────────────────────
    dropSocket() {
        const socket = this.socket;
        this.socket = undefined;
        if (socket === undefined)
            return;
        try {
            socket.close();
        }
        catch {
            // 已经关掉了：忽略
        }
    }
    onMessage(data) {
        let payload;
        try {
            payload = JSON.parse(data.toString());
        }
        catch {
            this.opts.log('debug', '收到非 JSON 帧，已忽略');
            return;
        }
        if (payload === null || typeof payload !== 'object')
            return;
        const frame = payload;
        // 动作回执：按 echo 对上号
        if ('echo' in frame && frame.echo !== undefined && frame.echo !== null) {
            const pending = this.pending.get(String(frame.echo));
            if (pending !== undefined) {
                clearTimeout(pending.timer);
                this.pending.delete(String(frame.echo));
                const response = frame;
                const status = response.status ?? (response.retcode === 0 ? 'ok' : 'failed');
                if (status === 'failed' || (response.retcode !== undefined && response.retcode !== 0)) {
                    pending.reject(new Error('OneBot 动作失败: ' + (response.message ?? response.wording ?? 'retcode=' + String(response.retcode))));
                }
                else {
                    pending.resolve(response.data);
                }
            }
            return;
        }
        if (typeof frame.post_type !== 'string')
            return;
        const event = frame;
        if (event.self_id !== undefined && event.self_id !== null)
            this.selfId = String(event.self_id);
        this.opts.onEvent(event);
    }
    /** 学到机器人自己的 QQ（配置留空时用于 @ 门控与自消息过滤）。 */
    async learnSelfId() {
        if (this.selfId !== '')
            return;
        try {
            const info = await this.call('get_login_info', {}, 5_000);
            if (info?.user_id !== undefined)
                this.selfId = String(info.user_id);
        }
        catch {
            // 有些实现不实现 get_login_info；靠 meta 事件兜底即可。
        }
    }
}
