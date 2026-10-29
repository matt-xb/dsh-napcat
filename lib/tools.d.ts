/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */
import type { Context } from '@deepseek-ai/cordis';
import type { LogLevel, OneBotConnection } from './onebot.js';
import type { Config } from './config.js';
export interface ToolDeps {
    /** 会话 id → 当前 QQ 会话（省略 chat_id 时用） */
    keyForSession?: (sessionId: string) => string | undefined;
    targetAllowed?: (sessionId: string, chatKey: string) => boolean;
    trackTextSend?: (sessionId: string, chatKey: string) => ((text: string, complete?: boolean) => Promise<void>) | undefined;
    /** 媒体（图/文件/语音/歌）已送达：本轮输出算完成，桥不再补发结尾确认句。 */
    markOutputSent?: (sessionId: string, chatKey: string) => void;
    /**
     * 同一轮同一会话同一内容只发一次：模型常在上一步成功后重新生成同一个发送调用。
     * 'claimed'=可以发（发送失败要 release 掉，允许真错误重试）；'repeat'=本轮已发过；'untracked'=不在活跃轮次。
     */
    claimSendOnce?: (sessionId: string, chatKey: string, contentKey: string) => {
        status: 'claimed';
        release: () => void;
    } | {
        status: 'repeat';
    } | {
        status: 'untracked';
    };
    taskMediaReceiver?: (sessionId: string, chatKey: string) => ((media: {
        kind: 'image' | 'file';
        url: string;
        name: string;
        caption?: string;
    }) => Promise<void>) | undefined;
    recordImageSend?: (chatKey: string, source: string, name: string) => Promise<void>;
    recentImages?: (chatKey: string) => Promise<string[]>;
    stickerRoot?: string;
    maxImageBytes?: number;
    maxFileBytes?: number;
    /** 允许操作的群号（群文件工具用），省略=不限制 */
    allowedGroups?: () => readonly string[];
    /** 把 chatKey → mnemon 空间 id 写进插件缓存 */
    rememberSpace?: (chatKey: string, spaceId: string) => Promise<void>;
    /** 当前解析后的插件配置（发语音/唱歌读 tts* / sing* 字段） */
    getConfig?: () => Config;
}
export declare function registerTools(ctx: Context, conn: OneBotConnection, log: (level: LogLevel, message: string) => void, deps?: ToolDeps): void;
