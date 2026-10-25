# NapCat 开发交接

更新：2026-10-24。当前项目此前未找到标准 handoff；本文件作为本仓库后续交接入口。

## 本次范围

- 独立 `spawn` 长任务保留，主聊天可继续；不做主会话轮换。
- `delivery: caller` 由插件接收宿主终态，仅向最初 parent 实例排队一个独立 followup；不走入站 dispatch / 标题 / watchdog / 自愈重投。
- 子任务及其子孙没有 QQ 直发权限。图片/文件工具在子任务中仅保存本地字节快照（原大小限制、目标绑定检查，禁止 HTTP URL）；图片回交经过宿主 `attachments.admitPromptContent`。文件是可读本地快照，不伪造附件引用。
- 回执文本和媒体清单按不可信任务数据引用；不进入新的派单附件快照；主智能体检查后决定回复。回执轮不能自动 task_start，QQ 发送仅允许原聊天。
- 每任务只接受一次终态；“已交主会话队列”只是入队，不是模型验收或 QQ 送达。非 completed 状态不冒充成功。拒绝、原父替换或目标权限撤回保留未回传。
- `workspace/session-stop` 中断并释放当时活跃任务，阻断进行中的回交；同会话后来新派任务不永久封禁。插件 stop 释放子任务并忽略迟到回执。宿主停止会丢弃已排队 inbox；不承诺跨重启恢复。

## 宿主 API 核实

按已安装桌面应用的真实 asar 内容核查：`dsh-subagent/lib/types/manager.js` 的 `startLocal` 支持 `delivery: caller`，caller 不自动 announce；`dsh-agent-loop` 的 followup 是 `send(message, next-turn, true)`，主忙时持久 inbox 排队，每轮 claim 一个普通消息。followup 返回 void，不代表已处理。插件仍容纳同步/异步拒绝，不伪称 QQ 成功。

## 验证与部署

- TypeScript typecheck 与 build 通过；完整离线回归 95/95。覆盖主忙排队、单次回交、主轮去重、真实媒体快照、图片官方准入、错群/URL/超限、父替换/停止/重用、拒绝、撤权及失败终态。
- 仅同步本次变化的 `lib/bridge.{js,d.ts}`、`lib/tasks.{js,d.ts}`、`lib/tools.{js,d.ts}` 和 `lib/index.js` 至当前插件安装目录；安装后逐字节 SHA-256 核对。版本仍为 0.3.23-xb.6，以 Git commit 区分本次源码修复；没有另发 Release/安装包。
- **未重启 DSH，也未自动重载插件**，避免打断当前 QQ 聊天与任务。磁盘同步不等于运行中模块已换新。空闲时在宿主插件管理中重载/禁用再启用；若宿主要求重启，需用户选择后续时机。仅刷新网页不等于插件重载。
- **真实 QQ、真实模型/生图工具、运行中插件热加载尚未验收**。重载后需检查：长任务时持续聊天、两任务交错完成、主检查文本和图片/文件后只回原目标一次、失败如实反馈。不同任务按完成时刻排队，不保证按派单顺序交付。
- 媒体快照位于原主会话 cwd 下的 `napcat-task-results/<task-id>/`，不自动删除，避免检查/发送前丢文件；长期磁盘占用需人工按需清理。聊天和媒体不提交 Git。

## 更新来源约定（2026-10-25 用户确认）

- 继续以 `matt-xb/dsh-napcat` 的 `main` 分支作为我们维护、验证和交付的来源，不用 npm 原版或原仓库直接覆盖现有分支。
- 同时关注原作者 `wzwei1990/dsh-napcat` 的 `main` 动态；按提交差异评估有价值的功能与修复，再选择性合并、跑相关检查并交付我们的分支。发现上游更新不等于已合并、已安装或已加载。
- 只读比较入口：`https://github.com/matt-xb/dsh-napcat/compare/main...wzwei1990:main`。独立桌面插件管理面板只展示分支版本及上游待评估提交，不自动安装市场中的同名原版，也不自动合并代码。
- GitHub 查询失败或限流时保留保护状态并提示重试，不显示为“已是最新”。本次仅补充来源约定与外部面板，不修改 NapCat 运行逻辑或宣称已升级正式安装。

## 修复：插件自带 sharp 抢宿主 libvips（0.3.23-xb.8，2026-10-25）

- 现象：QQ 群聊连续回「⚠️ 本轮回复失败，请稍后再试」，私聊正常；每轮 turn 只跑 ~386ms、模型零输出。
- 根因：插件导入 `@xenova/transformers` 时，它顶层 `import sharp` 加载自带 sharp 0.32.6（libvips 8.14.5）；宿主 `@deepseek-ai/dsh-attachment-local` 懒加载自己的 sharp 0.35.5（libvips 8.18.7）。同名 DLL `libvips-42.dll` 已被前者占用，宿主 `requireSharp()` 抛 `ERR_DLOPEN_FAILED: The specified procedure could not be found.`（`...@img\sharp-win32-x64\lib\sharp-win32-x64-0.35.5.node`），附件准入失败 → 整轮 error → 桥发通用失败提示。只有本轮请求要读图片附件时才触发，故私聊纯文本不受影响。
- 触发点不是图片：任何一次 `napcat_find_sticker`（`lib/semantic.js` → `import('@xenova/transformers')`）就足以毒化进程；图片附件只是让宿主 sharp 真正被调用的契机。
- 修复：`lib/semantic.js` 新增 `stubSharp()`，在 `import('@xenova/transformers')` 之前把插件解析到的 `sharp` 写入 `require.cache`（导出抛错 stub）。transformers 只用于文本 embedding，从不调用 sharp 图像 API。
- 源码与构建：`src/` 无 `semantic.ts`（该文件历来只有编译产物入库），直接改 `lib/semantic.js`，不用全量 tsc。
- 验证：`test/semantic-sharp-guard.test.mjs`（无守卫时 FAIL，加守卫后 PASS）；完整离线回归 102/102；在插件安装目录实跑 `semanticScores` 命中 `a|3:0.544`（约 150ms）且随后宿主的 sharp addon 仍 `LOADED`。
- 交付：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.8.tgz`；`profile package.json` 指向 xb.8；`lib/semantic.js` 与 tarball 逐字节一致（sha256 `4dae713c…`）。**未重启 DSH，也未重载插件**，运行中的进程 34052 仍是旧的（被毒化）状态，需用户重载/重启后群聊才恢复。

## 已有构建不一致（本次未扩大修复）

本次开始时工作树干净，但基线 `src/stickers.ts` / `src/text.ts` 与已提交的 `lib/stickers.js` / `lib/text.js` 不一致。全量 tsc 会覆盖现有已上线表情匹配/文本过滤逻辑；本次构建后恢复这两个无关 lib 文件到原提交，避免功能退回，再跑完整测试。后续开发不可把这两文件的构建退回夹入无关提交；应单独对齐源码与既有编译功能。本次未修改两文件的源码或已提交构建逻辑。
