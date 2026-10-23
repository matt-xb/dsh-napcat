/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */
import type { Context } from '@deepseek-ai/cordis';
import type { LogLevel, OneBotConnection } from './onebot.js';
export interface ToolDeps {
    /** 会话 id → 当前 QQ 会话（省略 chat_id 时用） */
    keyForSession?: (sessionId: string) => string | undefined;
    maxImageBytes?: number;
    maxFileBytes?: number;
    /** 允许操作的群号（群文件工具用），省略=不限制 */
    allowedGroups?: () => readonly string[];
    /** 把 chatKey → mnemon 空间 id 写进插件缓存 */
    rememberSpace?: (chatKey: string, spaceId: string) => Promise<void>;
}
export declare function registerTools(ctx: Context, conn: OneBotConnection, log: (level: LogLevel, message: string) => void, deps?: ToolDeps): void;
