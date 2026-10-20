/** 插件配置（schemastery 校验，全部带默认值，Web UI 设置页可直接改）。 */
import z from '@deepseek-ai/schemastery';
export const Config = z.object({
    mode: z.union([z.const('forward'), z.const('reverse')]).default('forward')
        .description('连接方式：forward=本插件连 NapCat（NapCat 在别的机器上时用这个）；reverse=本插件监听、NapCat 拨进来'),
    url: z.string().default('')
        .description('forward 模式：NapCat 的 WebSocket 地址（如 ws://81.70.163.182:3001）；留空=不连接（去设置页填）'),
    accessToken: z.string().role('secret').default('')
        .description('OneBot access_token；forward 作为 Bearer 发出，reverse 校验来者（reverse 下留空=不校验，不推荐）'),
    host: z.string().default('127.0.0.1')
        .description('reverse 模式监听地址；NapCat 在别的机器上时必须改为 0.0.0.0'),
    port: z.number().default(8643)
        .description('reverse 模式监听端口'),
    botQQ: z.string().default('')
        .description('机器人自己的 QQ；留空则从事件里自动学习（影响 @ 门控与自消息过滤）'),
    adminUsers: z.array(z.string()).default([])
        .description('管理员 QQ 列表（私聊 + 主动发送工具默认只对管理员开放）'),
    dmPolicy: z.union([z.const('admin'), z.const('open'), z.const('disabled')]).default('admin')
        .description('私聊策略：admin=仅管理员；open=任何人；disabled=关闭'),
    allowFrom: z.array(z.string()).default([])
        .description('dmPolicy=open 时的额外允许 QQ（留空=不限）'),
    groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('allowlist')
        .description('群聊策略：open=任何群；allowlist=只允许下面的群；disabled=关闭'),
    groupAllowFrom: z.array(z.string()).default([])
        .description('允许的群号列表'),
    requireMention: z.boolean().default(true)
        .description('群聊必须 @机器人 才响应（关掉=任何群消息都进模型，容易刷屏）'),
    ignoreSelf: z.boolean().default(true)
        .description('忽略机器人自己发出的消息（防止自循环）'),
    replyAsQuote: z.boolean().default(false)
        .description('回复时引用原消息（QQ 里显示为"回复"）'),
    splitMaxChars: z.number().default(1200)
        .description('单条 QQ 消息最大字数，超出自动分段；0=不分段'),
    reconnectMaxAttempts: z.number().default(0)
        .description('forward 模式连续失败多少次后放弃重连（0=无限重试，退避封顶 60s；日志会限流）'),
    workspacePath: z.string().default('')
        .description('QQ 会话挂载的工作区路径；留空=宿主进程 cwd'),
    agentPreset: z.string().default('')
        .description('QQ 会话挂载的 agent preset；留空=宿主默认'),
    provider: z.string().default('')
        .description('覆盖模型 provider；留空=宿主默认'),
    model: z.string().default('')
        .description('覆盖模型 id；留空=宿主默认'),
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn')]).default('info')
        .description('日志级别'),
});
