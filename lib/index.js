/**
 * dsh-napcat —— 把 DeepSeek Harness 接上 QQ（NapCat / OneBot 11）。
 *
 * 接线方式（forward 模式，NapCat 在别的机器上时用这个）：
 *   插件 --ws--> NapCat 的 WebSocket 服务
 *   用户 QQ --消息--> NapCat --事件--> 插件 --> 每会话一个 dsh agent
 *
 * 配置见 ./config.ts；安装与 NapCat 侧配置见 README.md。
 */
import { Bridge } from './bridge.js';
import { Config, resolveConfig } from './config.js';
import { OneBotConnection } from './onebot.js';
import { registerTools } from './tools.js';
export { Config };
export const name = 'dsh-napcat';
/** tools = 注册工具；agents = 按 QQ 会话创建/恢复 agent；workspaceRegistry = 把会话挂进工作区。 */
export const inject = ['tools', 'agents', 'workspaceRegistry', 'sessionPersistence', 'systemPrompt', 'agentDefaultModel', 'agentPresets', 'approval', 'sessionTitle', 'attachments'];
const LEVEL_RANK = { debug: 0, info: 1, warn: 2 };
export function apply(ctx, rawConfig) {
    // volatile 字段可能没有 schema 默认值，统一用内置默认值补齐
    const config = resolveConfig(rawConfig);
    const threshold = LEVEL_RANK[config.logLevel] ?? 1;
    const log = (level, message) => {
        if ((LEVEL_RANK[level] ?? 1) < threshold)
            return;
        const line = '[dsh-napcat] ' + message;
        if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
    };
    // 连接与桥互相引用，先用一个可替换的事件入口打断循环。
    let onEvent = event => {
        log('debug', '收到事件但桥还没就绪: ' + String(event.post_type));
    };
    const conn = new OneBotConnection({
        mode: config.mode,
        url: config.url,
        host: config.host,
        port: config.port,
        accessToken: config.accessToken,
        reconnectMaxAttempts: config.reconnectMaxAttempts,
        log,
        onEvent: event => onEvent(event),
        onStatus: connected => {
            if (connected)
                log('info', 'NapCat 通道就绪');
            else
                log('warn', 'NapCat 通道断开（会自动重连 / 反向模式等待接入）');
        },
    });
    const bridge = new Bridge({ ctx, config, conn, log });
    onEvent = event => {
        void bridge.handleEvent(event).catch(error => {
            log('warn', '处理入站事件失败: ' + (error instanceof Error ? error.message : String(error)));
        });
    };
    if (config.mode === 'forward' && config.accessToken === '') {
        log('warn', 'forward 模式下 accessToken 为空：NapCat 若配了 token，连接会被拒');
    }
    registerTools(ctx, conn, log, { keyForSession: sessionId => bridge.keyForSession(sessionId) });
    // 群/人性格：照 dsh-im 的动态提示词上下文（按 sessionId 注入额外人设）
    ctx.inject(['systemPrompt'], promptCtx => {
        const sp = promptCtx.systemPrompt;
        if (sp?.context === undefined)
            return;
        return sp.context({
            name: 'dsh-napcat:persona',
            order: 100,
            text: assembly => bridge.personaText(assembly),
        });
    });
    // 媒体说明：QQ 送来的图片/文件以 [图片: 路径] / [文件: 路径] 的形式出现在消息里，
    // 告诉模型该去哪拿（有视觉的模型可直接看图，没有的用 read_image / modlens 桥）
    ctx.inject(['systemPrompt'], promptCtx => {
        const sp = promptCtx.systemPrompt;
        if (sp?.context === undefined)
            return;
        return sp.context({
            name: 'dsh-napcat:media',
            order: 120,
            text: [
                '这个会话来自 QQ（NapCat 渠道）。用户发来的图片会被保存到会话目录下的 napcat-inbox/，',
                '消息里以 `[图片: <绝对路径>]` 出现；文件以 `[文件: <绝对路径>]` 出现。',
                '看到这类标记时：直接用 read_image 或 modlens 视觉桥读那个路径，不要反问用户要图；',
                '如果路径不存在或读不出来，再让用户重发一次。',
            ].join(''),
        });
    });
    // volatile 配置是"活值"：设置页保存不会重挂载插件，这里自己重建连接。
    const subscribeSettings = ctx;
    ctx.effect(() => subscribeSettings.on('settings/document-updated', ns => {
        if (ns !== 'dsh-napcat')
            return;
        const next = resolveConfig(rawConfig);
        if (JSON.stringify(next) === JSON.stringify(config))
            return;
        Object.assign(config, next);
        log('info', '配置已更新（设置页保存），重建 NapCat 连接');
        bridge.refreshPersonas();
        conn.reconfigure({
            mode: next.mode,
            url: next.url,
            host: next.host,
            port: next.port,
            accessToken: next.accessToken,
            reconnectMaxAttempts: next.reconnectMaxAttempts,
        });
    }));
    ctx.effect(() => {
        bridge.start();
        conn.start();
        return async () => {
            await bridge.stop();
            await conn.stop();
        };
    });
    log('info', 'dsh-napcat 已加载（mode=' + config.mode + (config.mode === 'forward' ? ', url=' + config.url : ', port=' + String(config.port)) + '）');
}
