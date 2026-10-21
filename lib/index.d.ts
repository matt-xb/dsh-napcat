/**
 * dsh-napcat —— 把 DeepSeek Harness 接上 QQ（NapCat / OneBot 11）。
 *
 * 接线方式（forward 模式，NapCat 在别的机器上时用这个）：
 *   插件 --ws--> NapCat 的 WebSocket 服务
 *   用户 QQ --消息--> NapCat --事件--> 插件 --> 每会话一个 dsh agent
 *
 * 配置见 ./config.ts；安装与 NapCat 侧配置见 README.md。
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { Config as ConfigShape } from './config.js';
export { Config };
export declare const name = "dsh-napcat";
/** tools = 注册工具；agents = 按 QQ 会话创建/恢复 agent；workspaceRegistry = 把会话挂进工作区。 */
export declare const inject: string[];
export declare function apply(ctx: Context, rawConfig: ConfigShape): void;
