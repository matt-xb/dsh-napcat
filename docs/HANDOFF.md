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

## 修复：设置页在暗色主题下看不见（0.3.23-xb.9，2026-10-25）

- 现象：DSH 设置 → NapCat 页面在深色主题下，输入框/下拉框是白底白字，几乎读不出内容。
- 根因：`client/index.js` 的 `style.input` 用 `background: var(--dsw-alias-bg-l1, #fff)`，而宿主主题表里**没有** `--dsw-alias-bg-l1`（全 asar 定义数 0，只有一处误引用），fallback `#fff` 生效；同时 `color: 'inherit'` 不跟主题。主按钮则相反，用 `business-primary` 当填充但文字写死 `#fff`，暗色下 business-primary 是浅蓝 `#7aaaff`，白字几乎看不清。
- 修复：输入框改用宿主输入框同一套 token `--dsw-alias-bg-layer-1` + `--dsw-alias-label-primary`；`style.btn` 文字色改 `--dsw-alias-label-primary`；`style.primary` 改宿主主按钮那一对 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`。全部保留原有 fallback 值。
- 验证：从 asar 抽出真实主题 CSS（`--dsw-alias-*` 亮/暗两套），用 `vm` 还原 `style` 对象渲染前后对比页；改前暗色三框全白、改后 `#232324` 底 + `#f9fafb` 字；亮色主题下黑色主按钮 + 白字照常。`node --check` 通过，完整离线回归 102/102。
- 交付：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.9.tgz`；`profile package.json` 指向 xb.9。前端改动需刷新页面或重载插件后生效，**本次未重启 DSH、未重载插件**，实机设置页尚未验收。

## 修复：模型把宿主 runtime context 复述进正文并发到群里（0.3.23-xb.10，2026-10-25）

- 现象：群聊一条正常回复末尾多出三行 `Time sampled while preparing turn 78, step 1: …` / `Browser time zone for this request: …` / `Elapsed since the preceding model-visible message: 10m 0s.`，原样发到了 QQ 群。
- 根因：不是桥拼装/转发带出来的。受害群会话的 `session.v4.jsonl.zstd` 里那条 `assistant/message` 事件（`turn:78, step:1`）中，`content[].type === 'text'` 的正文本身就把这段注入复述了进去（模型 `deepseek-v4.1-flash`，provider workbuddy）。真实注入是宿主 `@deepseek-ai/dsh-time-context` 每轮单独插入的 `user/message`（`source.kind: "time-context"`），模型把这文本抄进了答复。
- 为什么没拦住：`sanitizeReply` 原先只按「整段都是内部上下文」判定（命中即 `null` 丢弃），没有任何 runtime context 行的规则，所以和正文混在一起时原样放行。全量 477 个会话扫描另有 3 处同类（1 处群聊时间戳、2 处 `这个会话来自 QQ…` + `【本聊天历史与明确事实】`、1 处 `【本地自动触发，不是用户发言】`），都属「注入混进正文」这一洞。
- 修复：只在共享出口 `sanitizeReply` 里加 `stripRuntimeContext`（`src/text.ts` / `lib/text.js`），桥的自动回复、`napcat_send_message`、原始 OneBot 发送、任务回传、目标群/私聊全部共用。规则：以 `Time sampled while preparing turn \d+, step \d+:` 打头，且紧跟着还有别的标记行（`Browser time zone for this request:` / `Elapsed since the preceding (model-visible message|step context):`）才算注入，整块连块内空行一起删，其余正文一字不动；孤立一句（群里问「这是啥」）不删。剥完为空则沿用既有 `空消息不外发`，不会发空消息。
- 验证：`test/migration-text-memory.test.mjs` 新增一例（夹在中间 / 段首 / 整段都在 / 正常聊天提到同字样不删）；`npm run typecheck` 通过，完整离线回归 103/103（零跳过）。
- 交付：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.10.tgz`；`profile package.json` 指向 xb.10，安装目录 `lib/text.js` 与 tarball 逐字节一致。**未重启 DSH、未重载插件**，运行中进程仍是旧的，需重载后群聊才生效。
- 已知局限：只认这三类英文标记行，宿主以后换措辞要同步加规则；模型把注入改写成中文转述时无法识别。

## 已有构建不一致（本次未扩大修复）

本次开始时工作树干净，但基线 `src/stickers.ts` / `src/text.ts` 与已提交的 `lib/stickers.js` / `lib/text.js` 不一致。全量 tsc 会覆盖现有已上线表情匹配/文本过滤逻辑；本次构建后恢复这两个无关 lib 文件到原提交，避免功能退回，再跑完整测试。后续开发不可把这两文件的构建退回夹入无关提交；应单独对齐源码与既有编译功能。本次未修改两文件的源码或已提交构建逻辑。

## 修复：归档/静默吞回复、媒体后多余确认句、裸标签与本地路径、生图硬规则（0.3.23-xb.13，2026-10-26）

- 现象（用户报的三类）：①DSH 里归档对话后，再在 QQ 发消息后台收到但回复不推回；②发图/语音后那条消息后面还跟一句多余文字，群里还出现过 `![](D:\NapCat\stickers\bqb-smug-06.gif)` 这种把 markdown+本地路径当正文发出；③新群（1129828541）里蹦出后台思考/不该出现的东西，另有一次回复末尾多出 `</output>`。
- 根因一（吞回复）在会话层：`dispatch` 原本 `if (chat.fresh !== true)` 才上盾（注释假设新建会话不会失效），而归档后 `ensureChat` 恰好走新建路径（`fresh: true`）→ 一旦这个新会话压根没产生 turn/start，既没有 turn/end 也没有任何提示，整轮静默；`turnStarted` 是死字段（全文只有置 false 与读取，没有置 true），看门狗 alive 判定实际只剩 `lastEventAt > dispatchedAt`。
- 根因二（媒体后补一句）：`trackTextSend` 只在纯文本发送后置 `toolTextComplete`，`napcat_send_image` / `send_file` / `send_voice` / `sing` 发完不通知桥，turn/end 就把模型写的「已发图」当正文补发。历史线索：`bea3f24` 曾加 `recordMediaSend`，`5e16d2f` 把任务投递改成 `mediaReceiver` + `notify` 时把它整段删掉，前台链路随之回归。
- 根因三（裸标签/本地路径）：`stripToolSyntax` 只认 `DSML|antml:|function_calls|invoke|<br>|div|p|span`，`</output>`、`<result>`、HTML 注释、`![](D:\…jpg)` 全放行；已确认这些是模型自己吐进 `assistant/message` 的 text 块（会话 turn 的 text 自带），不是桥拼装带进来的。
- 根因四（生图）：插件提示词只有 `TEXT_REPLY_RULES` / `GROUP_REPLY_RULES` / `TASK_REPLY_RULES`，生图硬规则只写在用户全局规则里，模型在插件会话里看不到。
- 修复：
  - `src/bridge.ts:1319` 投递后一律上盾（例外：`chat.outputActive === true`，即上一轮还在跑、本条是排队的消息，此时没有 turn/start 属正常）；`src/bridge.ts:1399-1402` turn/start 到达即 `clearTimeout` + `startTimer=undefined` + `turnStarted=true`；`armWatchdog` 里给 timer 加 `unref?.()`，别拖住进程退出。
  - `src/tools.ts` 新增 `markOutputSent(sessionId, chatKey)`（`ToolDeps` + `markSent(exec, target)` 辅助），在 `napcat_send_image`、`napcat_send_file`（file 段/upload 两个分支）、`napcat_send_voice`、`napcat_sing`、`napcat_api` 的非纯文本发送成功后调用；`src/bridge.ts:756-761` 实现为 `outputActive` 时置 `toolTextComplete = true`；`src/index.ts:74` 接线。
  - `src/text.ts` `stripToolSyntax` 重写：逐行扫，``` 围栏内原样保留；整行只有标签/HTML 注释、整行是本地媒体绝对路径的直接丢；非代码段再剥 `![](本地绝对路径)` 与包装标签（`WRAPPER_TAGS` 白名单，未列出的普通标签如 `<b>` 原样留着）；保留原有 DSML/antml/invoke/parameter 行过滤与换行折叠。
  - `src/bridge.ts:46-47` 新增 `IMAGE_REPLY_RULES` 并在 `personaText`（`:1217`）拼进所有 QQ 会话。
- 验证：`npm run build` 通过；`npm test` → **105 tests, 105 pass, 0 fail**。新增用例：`test/bridge-integration.test.mjs`「watchdog covers brand-new chats and is disarmed by turn/start」（dispatch 后 `startTimer` 存在 → turn/start 后为 undefined 且 `turnStarted === true`）；`test/migration-text-memory.test.mjs`「wrapper tags and local media paths never reach QQ as text」（`</output>` 尾行、`<output>好了</output>`→`好了`、注释行、`![](D:\…)`、独占一行本地路径都会被剥；`[已发送图片：…]` 保留；围栏/反引号内不动；`a < b 且 c > d` 不误伤）。
- 未改：`droppedText` 仍然只留 warn 不代发（既有测试 `dropped tool-step narration warns once and is never auto-sent` 与 `multiple tool steps and tool-only completion do not become user-facing replies` 明确要求，不能靠补发工具步叙述解决吞回复）。
- 已知局限：看门狗仍以 10s 为界，模型侧极慢排队（10s 内既无 turn/start 也无任何事件）在排队消息场景不会误触发，但若宿主真的接了消息又不发任何事件，只能靠一次重投后给用户提示；`turnStarted` 现在才真正被置 true，历史代码里的 `fresh` 字段仅用于这一处判断，已不再影响上盾。
- 交付：见下方部署小节。

## 部署与验收（0.3.23-xb.13）

- 源码与构建：`src/{bridge,index,text,tools}.ts` 改完，`npm run build`（tsc，outDir `lib`）已跑，`lib/` 同步。
- 回归：`npm test` 105/105 全绿，无跳过。
- 安装：`D:\DeepSeekHarnessData\.dsh\profiles\desktop\node_modules\dsh-napcat\`，profile `package.json` 第 10 行仍走 `github:matt-xb/dsh-napcat`；本次需重载插件（或重启宿主）才生效，**未擅自重启**。
- 需人工验收：①归档一个 QQ 会话后再发消息应能正常回复（不再静默）；②发图/语音后不应再跟一句「已发图」；③群里不应再出现 `![](D:\…)`/`</output>`；④生图应走 `image_generate`。
- 已知局限：若宿主接了 followup 却既不产生 turn/start 也不发任何 session 事件，插件只能重投一次后提示「会话没有响应」；这是兜底而不是根治宿主侧卡死。
