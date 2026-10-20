/** 插件配置（schemastery 校验，全部带默认值，Web UI 设置页可直接改）。 */
import type Z from '@deepseek-ai/schemastery';
export interface Config {
    /** forward = 本插件主动连 NapCat 的 ws；reverse = 本插件监听、NapCat 拨进来。 */
    mode: 'forward' | 'reverse';
    /** forward 模式：NapCat 的 WebSocket 地址（如 ws://81.70.163.182:3001）。 */
    url: string;
    /** OneBot access_token：forward 时作为 Authorization 发出，reverse 时校验来者。 */
    accessToken: string;
    /** reverse 模式监听地址；NapCat 在别的机器上时必须是 0.0.0.0。 */
    host: string;
    /** reverse 模式监听端口。 */
    port: number;
    /** 机器人自己的 QQ；留空则从 meta 事件自动学习。 */
    botQQ: string;
    /** 管理员 QQ（私聊、工具发送默认只对管理员开放）。 */
    adminUsers: string[];
    /** 私聊策略：admin=仅管理员；open=任何人；disabled=关闭。 */
    dmPolicy: 'admin' | 'open' | 'disabled';
    /** dmPolicy=open 时的额外白名单（留空=不限）。 */
    allowFrom: string[];
    /** 群聊策略：open=任何群；allowlist=只允许 groupAllowFrom 里的群；disabled=关闭。 */
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    /** 允许的群号。 */
    groupAllowFrom: string[];
    /** 群聊是否必须 @机器人才响应。 */
    requireMention: boolean;
    /** 忽略机器人自己发出的消息（防自循环）。 */
    ignoreSelf: boolean;
    /** 回复时引用原消息（QQ 里表现为"回复"气泡）。 */
    replyAsQuote: boolean;
    /** 单条 QQ 消息的最大字数，超出按段落/句子分段发送；0=不分段。 */
    splitMaxChars: number;
    /** forward 模式连续失败多少次后放弃重连（0=无限）。 */
    reconnectMaxAttempts: number;
    /** QQ 会话挂载的工作区；留空=宿主进程 cwd。 */
    workspacePath: string;
    /** 会话挂载的 agent preset（留空=宿主默认）。 */
    agentPreset: string;
    /** 覆盖模型 provider（留空=宿主默认）。 */
    provider: string;
    /** 覆盖模型 id（留空=宿主默认）。 */
    model: string;
    /** 日志级别。 */
    logLevel: 'debug' | 'info' | 'warn';
}
export declare const Config: Z<Config>;
