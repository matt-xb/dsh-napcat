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

## 修复：TTS 服务自愈启动（0.3.23-xb.14，2026-10-26）

**问题**：`lib/tts.js` 只会 `fetch` `127.0.0.1:9880`，从不负责把服务拉起来。重启 DSH 后若 TTS 没起，唯一兜底是 Windows 计划任务 `NapCat-TTS-Watchdog`（已压到 PT1M），最坏仍有「最多 60 秒巡检 + 约 40 秒冷启动」的空窗，期间 `napcat_send_voice` 直接报「TTS 服务不可用」。

**改动**：

- `src/tts.ts`（→ `lib/tts.js` + `.d.ts`）
  - 新增 `TtsDeps` 注入接口（`fetch` / `spawn` / `exists` / `sleep` / `logFile` / `now`），默认走真实实现，测试可全替换，不真起进程。
  - `isConnectionError(err)`：认 `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `EHOSTUNREACH` / `ENOTFOUND` / `EPIPE`，以及 undici 的 `TypeError: fetch failed`（含 `cause.code`）与消息里的 connection refused。
  - `ensureTtsServer(config, log, deps)`：模块级 `Promise<boolean>` 单例，并发请求共用同一次启动；`finally` 里清空单例，失败后下个请求还能再试（但**单次合成只重试一次**，不会死循环）。
  - `startTtsServer`：读 `NAPCAT_TTS_PYTHON` / `NAPCAT_TTS_SERVER`，默认 `D:\NapCat\tts\index-tts\.venv\Scripts\python.exe` + `D:\NapCat\tts\tts_server.py`；两个路径都先 `existsSync` 检查，缺一个就返回 false 并 warn「启动器不存在」，直接走原报错。`spawn(python, [server, '--port', <来自 ttsServerUrl 的端口>, '--warmup'], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })` + `unref()`；`spawn` 的 `error` 事件与 `existsSync` 都兜住，不会抛到调用方。
  - `healthReady`：500ms 间隔、最多 90 秒轮询 `<ttsServerUrl>/health`，要求 HTTP ok 且 `{ok:true, loaded:true}`；超时返回 false 并 warn。
  - `synthesizeToWav`：`withGpu` 内首次 `synthesizeOnce` 失败且 `config.ttsAutoStart !== false` 且错误是连接类 → `ensureTtsServer` → 成功才重试**一次** `synthesizeOnce`；返回值/日志行为其余不变，`null` 语义保持（`src/tools.ts:367-370` 的报错文案不用动）。
- `src/config.ts`：`Config` 加 `ttsAutoStart: boolean`；schema 加 `ttsAutoStart: z.boolean().default(true)…volatile()`；`DEFAULTS` 加 `ttsAutoStart: true`。
- `client/index.js`：设置页 tts 分组加 `{ key: 'ttsAutoStart', label: 'TTS 服务没起时自动拉起（默认开）', kind: 'boolean' }`。
- `README.md`：版本行 → `v0.3.23-xb.14`；「本分支新增」加一条；配置表加 `ttsAutoStart` 行；排错表加「语音发不出来（TTS 没起）」。
- `test/tts-autostart.test.mjs`（新文件，4 例，全假依赖）：①首次 fetch 拒绝 → 触发一次 spawn（断言 `detached:true`、`--port 9880 --warmup`、stdio 重定向）→ 轮询 `/health` → 重试成功，且 `ttsCalls === 2`（只重试一次）；②三个并发 `ensureTtsServer` 共用一次启动（`spawned === 1`、`healthCalls === 2`）；③启动器 `exists: false` → `spawn` 0 次、合成只调 1 次、返回 `null`、日志含「启动器不存在」；④`ttsAutoStart: false` → 不自愈不重试。

**验证**：`npm run build` 通过；`npm test` → **109 tests, 109 pass, 0 fail**（基线 105 + 新增 4）。

**注意**：`src/gpu.ts` 的 `withGpu` 是全插件串行队列，两个并发 `synthesizeToWav` 在合成阶段本来就串行，所以并发单例的用例直接测 `ensureTtsServer` 而不是 `synthesizeToWav`。

**部署与验收（0.3.23-xb.14）**：

- 运行副本 `D:\DeepSeekHarnessData\.dsh\profiles\desktop\node_modules\dsh-napcat\`：`lib/tts.js`、`lib/tts.d.ts`、`lib/config.js`、`lib/config.d.ts`、`package.json` 已逐个覆盖并 sha256 核对一致。
- 发布包：`D:\NapCat\releases\dsh-napcat-0.3.23-xb.14.tgz`。
- **未重启 DSH**，需要重载插件才生效。
- 人工验收：①停掉 TTS（`Stop-Process` 掉 9880 的 python 或结束计划任务拉起的进程）→ 在 QQ 里让机器人发一条语音 → 首条可能慢 40 秒左右但应成功发出，`D:\NapCat\tts\logs\tts_server.out` 出现新的启动日志；②把 `NAPCAT_TTS_PYTHON` 指到一个不存在的路径再重载 → 发语音应立刻回到「TTS 服务不可用」提示，插件本身不报错、其他功能正常；③设置页能看到「TTS 服务没起时自动拉起」开关。

## 修复：音色定型（0.3.23-xb.15，2026-10-26）

**背景**：音色在服务端已定型（`DEFAULT_VOICE = refs/user/user_ref_dereverb_g4.wav`，即去混响的 g4 参考），插件侧默认值仍指向旧的 `u3.wav`，且 `alpha` 硬编码 0.6，导致插件发出的合成请求与新音色不匹配。

**改动（仅插件侧，服务端未再变动）**：

- `src/config.ts`：`ttsVoiceRef` 默认值 `D:/NapCat/tts/refs/user/u3.wav` → `D:/NapCat/tts/refs/user/user_ref_dereverb_g4.wav`（zod schema `default` 与 `DEFAULTS` 两处同步）。
- `src/tts.ts`：请求参数 `alpha: '0.6'` → `'0.45'`（音色相似度权重下调，贴近定型音色）；emo 八维向量保持不变，由服务端兜底，不新增配置项。
- 服务端对旧路径 `u3.wav` / `user_ref_new.wav` 做了自动映射（映射到 g4 并强制 `emo=[0,0,0,0,0,0.5,0,0.5]`、`alpha=0.45`），因此**插件未重载、旧配置仍在用旧路径时也能直接生效**。
- FORMANT 后处理（默认 1.07，音高不变、声道收窄）完全由服务端负责，插件不再做任何音色/音高处理。

**版本**：`package.json` → `0.3.23-xb.15`；`README.md` 版本行同步。

**验证**：`npm run build` 通过；`npm test` → **109 tests, 109 pass, 0 fail**（与 xb.14 基线一致，本次未新增用例）。

**部署与验收（0.3.23-xb.15）**：

- 运行副本 `D:\DeepSeekHarnessData\.dsh\profiles\desktop\node_modules\dsh-napcat\`：`lib/config.js`、`lib/config.d.ts`、`lib/tts.js`、`lib/tts.d.ts`、`package.json` 逐个覆盖并 sha256 与源码仓库核对一致。
- 发布包：`D:\NapCat\releases\dsh-napcat-0.3.23-xb.15.tgz`（解压后 `lib` 与安装目录 sha256 一致）。
- **未重启 DSH**，需重载插件后插件侧默认值才生效；服务端映射可保证重载前的旧路径请求也已使用新音色。
- 人工验收：让机器人发一条语音，确认音色为去混响的 g4、无旧 u3 的混响尾音；`tts_server.py` 未改动、未重启。

## 修复：音色换为银月参考（0.3.23-xb.16，2026-10-27）

**背景**：旧参考 `refs/user/user_ref_dereverb_g4.wav`（g4 手机录音去混响）实测 **<200Hz 能量仅 13%**、与真人相似度 **0.44**，听感「饱满过头 / 像 30 岁 / 太装」，用户已否决。

**新参考**：用户提供的银月配音 mp3，经转码得到 `refs/user/yinyue_raw.wav`（14.08s），再生成 `yinyue_ref.wav` 与 `yinyue_ref_n20/n24/n27.wav`；**用户 A/B 试听后选定 `yinyue_ref_n24.wav`**。

**改动**：

- 服务端 `D:\NapCat\tts\tts_server.py`（备份 `tts_server.py.bak-yinyue`）：`DEFAULT_VOICE = refs/user/yinyue_ref_n24.wav`；`FORMANT` 默认 `"1.0"`（不再做共振峰后处理）；legacy 映射名单扩展到 `u3.wav / user_ref_new.wav / user_ref_dereverb_g4.wav / raw_thin2.wav / raw_clean.wav`。
- `src/config.ts`：`ttsVoiceRef` 默认值 `D:/NapCat/tts/refs/user/user_ref_dereverb_g4.wav` → `D:/NapCat/tts/refs/user/yinyue_ref_n24.wav`（zod schema `default` 与 `DEFAULTS` 两处同步）。`ttsEmotion` 仍为 `calm`、`alpha` 仍为 `0.45`，新音色不需要改这两项。
- `src/tts.ts`：确认请求参数 `alpha: '0.45'`；插件侧无任何 formant/共振峰调用，也无硬编码 `1.07`（共振峰后处理只在服务端，现已关闭）。

**版本**：`package.json` → `0.3.23-xb.16`；`README.md` 版本行同步。

**验证**：`npm run build` 通过；`npm test` → **109 tests, 109 pass, 0 fail**（基线一致，未新增/删除用例，无测试写死旧 g4 路径或 1.07）。服务端重启后实测合成正常（`D:\NapCat\tts\out\yinyue\live_check.wav`，**F0 257Hz**、时长 5.57s）。

**部署与验收（0.3.23-xb.16）**：

- 运行副本 `D:\DeepSeekHarnessData\.dsh\profiles\desktop\node_modules\dsh-napcat\`：`lib/config.js`、`lib/config.d.ts`、`lib/tts.js`、`lib/tts.d.ts`、`package.json` 逐个覆盖并 sha256 与源码仓库核对一致。
- 发布包：`D:\NapCat\releases\dsh-napcat-0.3.23-xb.16.tgz`（解压后 `lib/config.js`、`lib/tts.js`、`package.json` sha256 与安装目录一致）。
- **未重启 DSH、未重载插件、未动 9880 的 TTS 服务**，需重载插件后插件侧默认值才生效；服务端 legacy 映射可保证重载前仍在用旧 g4 路径的请求也已走银月音色。
- 残留：`src/sing.ts` 唱歌的音色转换 target 仍是 `D:/NapCat/tts/refs/user/u3.wav`，本次未改（唱歌链路未验证）。

## 修复：音色预设与切换（0.3.23-xb.17，2026-10-27）

**背景**：用户要求保存两个可切换的音色，名字固定 **原版**（最初的 u3 音色）与 **银月**（当前默认），随时能切，不需要改配置或重载插件。

**关键设计（为什么原版不能直接用 u3.wav）**：`D:\NapCat\tts\tts_server.py` 的 `synth()` 开头有一段 legacy 兼容映射——`voice` 为空或 basename 落在 `u3.wav / user_ref_new.wav / user_ref_dereverb_g4.wav / raw_thin2.wav / raw_clean.wav` 里时，强制替换成 `DEFAULT_VOICE`（`yinyue_ref_n24.wav` = 银月），并强制 `PRESET_EMO / PRESET_ALPHA`。这段是给「插件没重载、旧进程还在传 u3.wav」兜底的，**不能删也不能改名单**。所以「原版」另存一份：`python -c soundfile` 读 `refs/user/u3.wav`（24000Hz 单声道 7.7s，峰值 0.4839）→ 重采样 44100Hz 单声道 PCM_16 写成 `refs/user/original_ref.wav`（峰值仍 0.4839，未触顶 0.95 故未归一）。文件名不在 legacy 名单里，能被正常使用。

**改动**：

- 新增 `src/ttsvoice.ts`：`resolveVoiceRef(config)` 按「运行时覆盖 > `ttsVoices[ttsVoice]` > `ttsVoiceRef`」解析参考音频，全空时兜底 `yinyue_ref_n24.wav`；`setVoiceOverride(name)` / `resetVoiceOverride()` / `currentVoiceName(config)`。覆盖是模块级变量，只在进程内有效，重启回到配置的 `ttsVoice`。
- `src/config.ts`：新增 `ttsVoices: z.dict(z.string())`（默认 `{原版: original_ref.wav, 银月: yinyue_ref_n24.wav}`，volatile）与 `ttsVoice: string`（默认 `银月`）；`ttsVoiceRef` 保留作为旧配置兜底，描述补一句「优先用 ttsVoices」。`DEFAULTS` 同步。
- `src/tts.ts`：请求参数 `voice` 从 `String(config.ttsVoiceRef ?? '')` 改为 `resolveVoiceRef(config)`。
- `src/sing.ts`：音色转换 target 同样改为 `resolveVoiceRef(config)`（替代原先读 `ttsVoiceRef` 的写法），唱歌跟随同一个音色。
- `src/tools.ts`：新增工具 `napcat_voice`（`action: list|switch`，`name` 可选）。`list` 回「当前：银月。可选：原版、银月」；`switch` 必须命中预设键，否则报错并列出可选值；未注入 `getConfig` 时退回 `DEFAULTS`。
- `src/bridge.ts`：`TEXT_REPLY_RULES` 加一句——换音色直接调 `napcat_voice`，不让用户自己改配置。

**版本**：`package.json` → `0.3.23-xb.17`；`README.md` 版本行同步；`dsh.plugin.json` 的 `version` 沿用 `0.3.23`（该文件自 xb.6 起只记基础版本，历次 xb 增量不动它）。

**验证**：`npm run build` 通过；`npm test` → **111 tests, 111 pass, 0 fail**（基线 109 未删未改，新增 `test/voice-preset.test.mjs` 2 条：解析优先级、`napcat_voice` 的 list/switch/非法名）。

**音色实测（服务端 9880 未改未重启）**：同一句「你好，我是小白，今天天气不错。」分别用两个参考合成，librosa.pyin(80–600Hz) 测 F0 中位数——`original_ref.wav` 样本 **354.0Hz**（6.46s）、`yinyue_ref_n24.wav` 样本 **267.5Hz**（4.22s）；参考音频本身分别 339.0Hz / 285.9Hz。两条音色差异明确，原版不再被 legacy 映射吃掉。

**部署**：运行副本 `D:\DeepSeekHarnessData\.dsh\profiles\desktop\node_modules\dsh-napcat\` 覆盖 `lib/ttsvoice.js`、`lib/ttsvoice.d.ts`、`lib/config.*`、`lib/tts.*`、`lib/sing.*`、`lib/tools.*`、`lib/bridge.*`、`package.json`、`README.md` 并逐个 sha256 核对；发布包 `D:\NapCat\releases\dsh-napcat-0.3.23-xb.17.tgz`。**未重启 DSH、未重载插件、未动 9880 服务**——插件侧新逻辑需重载后才生效。

## 修复：音色按会话隔离（0.3.23-xb.18，2026-10-27）

**为什么改**：xb.17 的 `src/ttsvoice.ts` 用模块级 `let override: string | undefined` 存运行时音色，`napcat_voice` 一 switch，整个进程所有私聊 + 所有群一起变。用户实测指出「不能你一切换所有群和私聊都切换了」，要求私聊 A 用银月、群 B 用原版各管各的。

**改法**：覆盖从「一个全局变量」换成 `Map<chatKey, 预设名>`，chatKey 形如 `private:993484108` / `group:123456789`。

**优先级**（`currentVoiceName(config, chatKey)` / `resolveVoiceRef(config, chatKey)` 同一套）：该 chatKey 的覆盖 > `ttsVoices[config.ttsVoice]` > `ttsVoiceRef` > 内置兜底 `yinyue_ref_n24.wav`。chatKey 为空串/undefined 时跳过覆盖这一层，保持原来「全默认」行为（老调用方不受影响）。

**持久化**：新增 `src/voicestore.ts`，把这张表写到 `<workspacePath>/voice-presets.json`（`join(config.workspacePath || process.cwd(), 'voice-presets.json')`，与 memory 根同一基准）。格式就是一张扁平对象：

```json
{"private:993484108":"银月","group:123456789":"原版"}
```

首次调用时懒加载一次（读不到当空；文件损坏只 `warn` 不抛；换 workspacePath 才重读）。写入先写 `voice-presets.json.tmp` 再 `rename`，保证原子性，不会留下半个文件。导出 `loadVoiceStore(config,log)` / `saveVoiceStore(config,log,map)` / `setStoredVoice(config,log,chatKey,name)` / `getStoredVoice(chatKey)` / `resetVoiceStore()`（测试清缓存）。

**为什么内存表放在 ttsvoice.ts**：`voiceOverrides` 是全局唯一一份，`voicestore` 只负责它的读写盘；否则两边各有一张 map 会互相看不见。

**改动**：

- `src/ttsvoice.ts`：`setVoiceOverride(chatKey,name)` / `getVoiceOverride(chatKey)` / `resetVoiceOverride(chatKey?)`（无参清全部）；`currentVoiceName`、`resolveVoiceRef` 加 `chatKey?` 参数。
- `src/voicestore.ts`（新增）：上述持久化。
- `src/tts.ts`：`synthesizeToWav(text, config, log, deps = {}, chatKey?)`，一路透传到 `resolveVoiceRef(config, chatKey)`；`TtsDeps` 不变。
- `src/sing.ts`：`synthesizeSing(scoreText, config, log, chatKey?)` 同样透传，唱歌跟随本会话音色。
- `src/tools.ts`：`napcat_voice` 新增可选 `chat_id`（省略=当前会话，走 `resolveChat`）；`list` 回「当前会话 <chatKey> 的音色：X。可选：原版、银月」；`switch` 用 `setStoredVoice` 写该会话并落盘，回「已把 <chatKey> 切换到 X」；`napcat_send_voice`/`napcat_sing` 合成时传 `target.kind + ':' + target.id`；工具描述补「切换只影响当前这个会话」。
- `src/bridge.ts`：提示词「换音色直接调 napcat_voice」后补「只影响当前这个会话」。

**验证**：`npm run build` 通过；`npm test` → **114 tests, 114 pass, 0 fail**（基线 111 未删未改，新增 `test/voice-scope.test.mjs` 3 条：两个 chatKey 各自 switch 互不影响、写盘后清内存能读回、未设覆盖回落 `config.ttsVoice`）。`test/voice-preset.test.mjs` 只做签名适配（`setVoiceOverride(KEY,…)`、`resolveVoiceRef(config,KEY)`、`synthesizeToWav(...,KEY)`、`napcat_voice` 带 `chat_id`），断言原样保留。

**部署**：运行副本 `D:\DeepSeekHarnessData\.dsh\profiles\desktop\node_modules\dsh-napcat\` 同步 lib/*.js、lib/*.d.ts、package.json、README.md 并逐个 sha256 核对；发布包 `D:\NapCat\releases\dsh-napcat-0.3.23-xb.18.tgz`。**未重启 DSH、未重载插件、未动 9880 服务**——新逻辑需重载后才生效。

## 新功能：语音收发可换阿里云百炼（0.3.23-xb.20，2026-10-30）

**为什么改**：这台机器没装本机语音模型（whisper.cpp / IndexTTS），用户不想部署，要求把「听」和「说」改成阿里云百炼的云端接口。本机实现必须原样保留——别的机器（家里那台）用它。

**改法**：云端只做 provider，不动上层调用链。两个开关 `voiceAsrProvider` / `voiceTtsProvider`（`local` | `aliyun`），默认 `local`，装好后在设置页手动切。

**接口（官方文档，未用真实 key 验证）**：

- 识别 `qwen3-asr-flash`，OpenAI 兼容端点 `POST {base}/compatible-mode/v1/chat/completions`，body `messages[0].content[0].input_audio.data` = `data:audio/wav;base64,…`，文本取 `choices[0].message.content`。同步接口，单文件 ≤10MB / ≤5 分钟（QQ 语音远小于此）。
- 合成 `qwen3-tts-flash`，`POST {base}/api/v1/services/aigc/multimodal-generation/generation`，body `{"model","input":{"text","voice","language_type":"Chinese"}}`，返回 `output.audio.url`（24 小时 OSS 链接）→ **再 fetch 一次**拿字节。单次 ≤600 字符，超了直接回退文字。

**改动**：

- `src/aliyun.ts`（新增，约 170 行）：`transcribeAliyun(wav, config, log, deps)` / `synthesizeAliyun(text, config, log, deps)`；`AliyunDeps { fetch? }` 供测试注入；内部 `postJson` 统一处理 Bearer + 超时 + JSON 解析 + `code/message` 提取；`describeError` 兼容 `output.message`。合成落地为临时 wav（RIFF 判断，否则 `.mp3`）。
- `src/voice.ts`：`transcribeRecord(conn, fileRef, config, log, deps: VoiceDeps = {})` 加第 5 个可选参数；`transcribeOnce` 拿到 base64 解成 Buffer 后先判 `voiceAsrProvider === 'aliyun'` 直走云端（不落盘、不起子进程），否则原样走 whisper。串行队列与 `MAX_PENDING=2` 不变。
- `src/tts.ts`：`synthesizeToWav` 里云端分支**不进 `withGpu`**（那是本机显存互斥，云请求排队只是白等），直接 `synthesizeAliyun`；本机分支原样。
- `src/config.ts`：`Config` 接口 + zod schema（`.volatile()`）+ `DEFAULTS` 三处同步加 `voiceAsrProvider`(local)、`voiceTtsProvider`(local)、`aliyunApiKey`(`z.string().role('secret')`)、`aliyunAsrModel`(qwen3-asr-flash)、`aliyunTtsModel`(qwen3-tts-flash)、`aliyunTtsVoice`(Cherry)。
- `client/index.js`：设置页语音分组补 6 项（两个 `select`、一个 `password`、三个 `text`），并把 `voiceToText` 标签里「本机 whisper」改成「后端见下方」。

**失败语义**：云端 TTS 失败返回 `null` → `napcat_send_voice` 抛「语音合成失败…改用文字发送」；云端 ASR 失败抛错 → `bridge.resolveVoice` 回退 `[语音]` 占位。**不自动降级去拉本机模型**（这台机器没装，切过去只会再等一次超时）。

**验证**：`npm run build` / `typecheck` 通过；`npm test` → **124 tests, 124 pass, 0 fail**（基线含远端 xb.19 的重复发送拦截用例，新增 `test/aliyun-voice.test.mjs` 8 条：ASR 请求形状与取文本、没 key 不发请求、错误码透出、TTS 两段式拿 URL、超 600 字不请求、云端报错返回 null、`voiceTtsProvider=aliyun` 不碰 127.0.0.1、`voiceAsrProvider=aliyun` 不起 whisper）。全部假 fetch，不联网。

**版本号说明**：本功能最初按 xb.19 写，提交时发现远端 `a125efc`（同轮内重复发送拦截）已占用 `0.3.23-xb.19`，故 rebase 到该提交之后改发 **xb.20**。

**部署**：运行副本 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-napcat\` 同步 `lib/` 与 `package.json`、`README.md`。**新配置字段需重载插件后设置页才出现**。

**未做的**：`aliyunBaseUrl`（地域化工作空间域名）没做成配置，`src/aliyun.ts` 里 `BASE_URL` 常量写死 `https://dashscope.aliyuncs.com`；要用私有部署域名改那一行。云端音色是阿里自带系统音色（`Cherry` 等），与原「银月」≠ 同一个声音，声音复刻需要另开服务。

## 改进：云端音色改成下拉框（0.3.23-xb.21，2026-10-30）

**为什么改**：用户去阿里云百炼控制台找「选语音 / ASR / TTS」的地方，找不到；xb.20 把 `aliyunTtsVoice` 做成了自由文本框，用户得自己去查 voice 参数名（`Cherry`、`Ethan`…），无从下手。

**改法**：`client/index.js` 顶部加 `ALIYUN_VOICES` 常量（48 项，取自官方音色列表 <https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list> 的**非实时**合成那张表），`aliyunTtsVoice` 从 `kind: 'text'` 改成 `kind: 'select'`。选项左值是 API 里传的 voice 参数（如 `Cherry`），右值是中文名 + 性别 + 一句话特点（如 `芊悦 · 女 · 阳光亲切`），用户在设置页直接认得出来。

**没动的**：`src/config.ts` 里 `aliyunTtsVoice` 仍是 `z.string()`，不做枚举校验——阿里以后加音色不用跟着改代码，手填生僻音色也还能存进去。下拉只是给人用的。

**验证**：`node --check client/index.js` 通过；`npm test` → 124 tests, 124 pass（纯前端字段改动，不影响 lib）。

**部署**：同步 `client/index.js`、`package.json`、`README.md`。**前端改动要重载插件（或刷新页面）才生效**。

## 重做设置页 UI（0.3.23-xb.24，2026-10-30）

**为什么改**：用户反馈设置页「太丑」「做的有点儿太简陋了，而且上下很长，我要滚动到好下面才能看得到有些东西」。旧页把 67 个字段 `FIELDS.map` 平铺一列，保存按钮排在数组之后 = 页面最底部，必须滚到底才能保存。

**改法**（只动 `client/index.js`，不新增依赖、不引构建链、不碰 `src/`）：加载形态 `window.__ModuleLoader__.load({...})`（`client/index.js:20-27`）原样保留；`FIELDS` 的 key/label/kind/options/placeholder 一字未改，只在旁边加分组表。

- `client/index.js:143-158` 新增 `GROUPS`：primary（常用，10 项：mode/url/accessToken/botQQ/adminUsers/dmPolicy/groupPolicy/requireMention/voiceAsrProvider/voiceTtsProvider）、connection（连接与门控 9）、session（会话与人格 3）、memory（群记忆 6）、voice（语音识别 5）、tts（语音合成 9）、aliyun（阿里云云端语音 2）、advanced（`collapsed:true`，23 项）。
- `client/index.js:161-181` 新增 `FIELD_BY_KEY` 索引 + 漏项兜底：分组表没写到的字段自动并入 advanced 并 `console.warn`，字段不会静默消失；重复 key 也被过滤。
- `client/index.js:186-232` 原内联 style 对象换成 `CSS_TEXT` 模板串，类名统一 `npc-*`：`.npc-savebar{position:sticky;bottom:0;…}`（吸底保存条，`border-top` 分隔 + `var(--dsw-alias-bg-layer-2)` 底色）、`.npc-card`（宿主卡片 stroke/fill/`--dsw-radius-xl`）、`.npc-grid{repeat(auto-fit,minmax(240px,1fr))}`（适配宿主 564px 可用宽，不再写死 620px）。全部走宿主 `var(--dsw-*)` token，没有自创颜色。
- `client/index.js:271-317` `renderField(field, value, onChange, disabled)` 加第 4 个参数，改用 className（32px 输入框、36px 按钮、focus 环同宿主）。
- `client/index.js:319-355` 新增 `renderGroupFields` 与 `DraftPage(props)`：标题 + 说明 + revision/可写徽标 → 吸底保存条 → 分组卡片 → `<details>` 高级设置（summary 带「N 项」，箭头样式抄宿主 models 页）。
- `client/index.js:361-478` `NapcatSettingsPage` 加 `const [loaded, setLoaded] = react.useState({})`，`load()` 里 `setLoaded(normalized)`；`dirty = JSON.stringify(draft) !== JSON.stringify(props.loaded)`，未改动时按钮文案「已保存」且 disabled；只读（`writable !== true`）时按钮置灰并显示原因（复用此前只写不读的 `writable` 状态）。`save()/load()/toList()/unwrap()/remoteOf()` 语义完全未动。

**验证**：`node --check client/index.js` 通过；用临时 react 桩跑渲染冒烟（不在仓库里）——控件 67 个（input 57 / select 9 / textarea 1）一个没丢，页面类名 24 个全部在 `CSS_TEXT` 里有定义，无改动时保存按钮 disabled、改 `botQQ` 后可点，readonly 时出现只读提示且徽标转 `npc-dot--off`。`npm run typecheck` / `npm run build` 通过；`npm test` → **126 tests, 126 pass, 0 fail**。

**交付**：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.24.tgz`（shasum `799612f2fd16d5688a34cf12039ccf9fc93c0322`），已装到 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-napcat`（旧版备份在 `C:\Users\Administrator\.dsh\profiles\desktop\backup-dsh-napcat-xb.23-20261030115213`），`diff -r` 核对 tarball 的 `client/`、`lib/`、`package.json` 与安装目录一致。安装时因 profile 里既有的 `@wenbin_wb/dsh-bridge` peer 冲突（要 `@deepseek-ai/dsh-llm@>=0.1.0-rc.6` 解析到 0.1.0-rc.8，实际装 0.2.1-rc.5）必须加 `--legacy-peer-deps`；副作用是清掉插件嵌套 `node_modules` 里 111 个与宿主重复的包（`@deepseek-ai/*`、`@types/ws`、`typescript`），`ws`、`@xenova/transformers`、`onnxruntime-node`、`sharp` 均仍在且可解析。

**未验证 / 需注意**：**没有重启 DSH，也没有在真实 GUI 里看过这页**——样式是按宿主 CSS 变量抄的，实际观感要刷新宿主客户端（前端改动重载插件或刷新页面即可，不需要重启宿主）后才能确认。

## 出口收口：决策载荷 JSON 与脏输入语料（0.3.23-xb.25，2026-10-30）

**现场**：群里先发「复读机没电了」，紧接着又发了一整块 ```json 围栏，内容是
`{"language":"zh-CN","date":"2026-10-30","responses":[{"id":"m00358","should_reply":false,"reason":"用户重复发送同一句粗口…"}]}`。

**那个 JSON 从哪来的（结论：模型自己编的，不是宿主也不是插件）**：

- `src/` 下 grep `should_reply|shouldReply|responses|batch` 零命中 —— 插件里没有这个格式。
- 宿主 `E:/deepseek 桌面版/resources/app.asar`（182 MB）grep `should_reply` **零命中** —— 不是宿主注入的提示词或批处理产物。
- 决定性证据是会话日志原始事件（`assistant/message`，seq 982，turn 100 step 1）：那轮 `content` 只有 `[{type:'reasoning'},{type:'text',text:'\n\n\n\n```json\n{…should_reply…}\n```'}]`，`source.kind = "model"`。也就是说模型把「哪条要回」的内部判断臆造成一个 JSON，落在**唯一一个 text block**里，桥照单全收当正文发了；同一会话下一轮同样输入它回的是 `[[NAPCAT_SILENT]]`。JSON 里的 `m00358` 也是模型仿上下文里 ACP 消息 ref（`mNNNNN`）编的号。
- 所以**没有「提示词源头」可改**。根因是出口只有针对具体字符串的黑名单，没有识别「结构化内部产物」这一类。

**改法**（`src/text.ts`，新增 4 个私有函数 + 1 个常量，`sanitizeReply` 首行调用）：

- `DECISION_KEYS`（src/text.ts:212）`should_reply/shouldReply/should_respond/shouldRespond/should_speak/reply_decision`；`isDecisionPayload`（src/text.ts:213-220）递归数组，对象带任一决策键即真，或 `responses`/`results` 是数组且每项都真。
- `matchJsonEnd`（src/text.ts:222-240）从 `{`/`[` 找配对位置，认字符串内转义，不完整返回 -1。`isDecisionJson`（src/text.ts:242-250）parse 得出来且带决策字段才算；**解析失败一律当正文**。
- `isBlockSolo`（src/text.ts:252-259）只有前后都是行边界才算「独占一块」——句子里引用 `{"should_reply":false}` 不动（用户可能就是在问这段）。
- `stripDecisionPayload`（src/text.ts:263-283）：整条裸 JSON → `''`；代码围栏块（含 ```` ``` ```` 行）整块删；再扫裸 JSON 块。`sanitizeReply` 首行改为先过它（src/text.ts:286）。
- 提示词侧加一句兜底（src/bridge.ts:44）：`没有回复价值可以只输出 [[NAPCAT_SILENT]]，不要用任何 JSON 或字段说明「哪条回、哪条不回」`。
- shortcut 已标注（src/text.ts:262）：只删独占整块的 JSON，混在句子中间的靠提示词约束。

**白名单方案：评估了，没做**。彻底白名单（只放行确定是自然语言的内容，其余全丢）在本插件不成立：出口同时承载用户要的代码块、表格、配置文件、日志片段（`napcat_send_message` 给别的聊天发长文、后台任务回传结果都走同一条 `sanitizeOutgoingMessage`），判据只能是「像不像自然语言」，而模型生成的正文和模型幻觉的内部产物在**语法上同构**——这轮泄漏物本身就是合法 JSON、没有可判别的语义标记。做白名单等于用更粗的启发式换更大的误伤面（用户要的代码被吞）。**改成按类型收口**：能确定归类的泄漏物（宿主头/群上下文头/宿主通知块/伪角色行/runtime context/包装标签/工具语法/本地媒体路径/决策载荷）在共享出口一处剥，剥完为空就不发；剩下的靠提示词约束，不赌全量白名单。

**外发位置全清点**（本次逐处确认）：

| 位置 | 触发条件 | 兜底 |
| --- | --- | --- |
| `src/onebot.ts:109-111` | 任意 `send_msg`/`send_group_msg`/`send_private_msg` | `sanitizeOutgoingMessage` —— **全插件唯一线边界，所有发送必经** |
| `src/bridge.ts:1443` | 模型 `assistant/message` 正文 | `sanitizeReply`，null → `outputBlocked` 整轮不发 |
| `src/bridge.ts:1566` | 桥主动发送（turn/end、主动发言、任务回执） | 再 `sanitizeReply`，null 时 strict 抛错 |
| `src/bridge.ts:1600` | `conn.call('send_msg')` | 上游已 clean + onebot 线边界二次 |
| `src/bridge.ts:784` | `trackTextSend` 记录已发文本 | `sanitizeReply`（只用于去重比对） |
| `src/tools.ts:128` | `sendSegments`（发图/文件附文字） | `sanitizeOutgoingMessage` |
| `src/tools.ts:146` | `napcat_send_message` | `sanitizeReply` + `splitText(1200)`，空则抛 |
| `src/tools.ts:163` | 上者的 `conn.call('send_msg')` | 入参已 clean，线边界再兜一次 |
| `src/tools.ts:245` | `napcat_api` 任意 `send_*` 动作 | `sanitizeOutgoingMessage` |
| `src/tools.ts:421` / `:467` | 语音、唱歌 | 只发 `{type:'record'}`，无文本，不适用 |
| `src/tasks.ts:159` | 后台任务结果回传 | `sanitizeReply` 后再交给桥 |

以上 11 处没有一处裸奔：文本类全部收敛到 `sanitizeReply`/`sanitizeOutgoingMessage` 两个函数，最终再由 onebot 线边界兜一次。

**脏输入语料**：新增 `test/leak-corpus.test.mjs`，表驱动三组 —— `DUMP` 18 条（本次决策载荷 6 条：围栏原样/裸 JSON/正文后跟 JSON/camelCase/数组/results；加 system_warning 成对与未闭合、system_reminder 夹杂、宿主头、群上下文头、User:、助手:、单行 assistant、runtime context 整块与正文后、包装标签、工具语法、本地图片语法、静默标记）、`KEEP` 9 条（代码块里的 JSON、对象字面量、句子中间引用 JSON、行内反引号、提到标签名/字段名/runtime 字样、多行正文、尖括号比较）、以及「剥空后必须抛空消息」。以后每次实测泄漏把原文加进 `DUMP` 即可。

**验证**：`npm run typecheck` / `npm run build` 通过；`npm test` → **129 tests, 129 pass, 0 fail**（基线 126 + 新文件 3 条）。

**交付**：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.25.tgz`（sha1 `abbd65a0657b54d83ee0ff5a7c9eb2fa6522464f`，132015 字节），已装到 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-napcat`（旧版备份 `backup-dsh-napcat-xb.24-20261030123756`），`npm install --legacy-peer-deps` 安装，`diff -r` 核对 tarball 的 `lib/`、`client/`、`package.json` 与安装目录一致，安装后 `require('dsh-napcat/package.json').version` = `0.3.23-xb.25`，`lib/text.js`、`lib/bridge.js` 与仓库源码构建产物逐字节相同。

**未验证 / 需注意**：**没有重启 DSH，也没有在真实 QQ 里复现这次泄漏再验证修复**——真实效果要重载插件后由模型再出现同类幻觉才能确认；`stripDecisionPayload` 对「决策 JSON 夹在句子中间」是已知漏网点（shortcut 已标注）。

## 出口收口：思考独白与控制标记残片（0.3.23-xb.26，2026-10-30）

**现场**：2026-10-30 12:30 私聊连续两条异常。第一条在正文后面继续吐自我推演：

「？？ 用户说"比如 ？？"，我回"？？"作为演示。 直接回。 ？？ 等等，我上一轮已经发过"……"，这轮发"？？"正好演示。就回。 ？？ 直接输出文字即可。？？」

第二条只剩残渣：`</apc">!!!` 加三行 `!!!`。同一时段还出现过 `<|im_start|>` / `<|im_end|>` 与全角竖线写的 `｜｜DSML｜｜ invoke` 系列被逐字发出。

**根因（用会话日志逐条证实，不是从现象倒推）**：

- 会话日志 `C:\Users\Administrator\.dsh\sessions\--E-Documents-deepseek-harness-default-workspace-napcat-napcat-private-993484108--\napcat-private-993484108-wnel8vu-r1\session.v4.jsonl.zstd` 是 1588 个 zstd 帧首尾相接（不是单流），按 magic `28 b5 2f fd` 逐帧 `zstdDecompressSync` 再拼接才解得开。
- 泄漏的那几轮（turn 163/164/165/167/169/170/171）里，`assistant/message` 的 `content` 中 reasoning 块长度都是 0 或单个空格 `" "`，**所有独白、`</apc">`、`｜｜DSML｜｜` 全都写在唯一的 text 块内部**。所以不是把 reasoning 通道混进了正文，而是模型自己把思考写进了正文。
- 因此「bridge 侧只取 content」这条路无解——它本来就只取 text 块：`src/bridge.ts:1653-1662` 的 `messageText(message)` 只收 `item.type === 'text' && typeof item.text === 'string'` 再 `parts.join('')`。取值处没有错，只能在出口清。
- 出口三处都过 `sanitizeReply`：`src/bridge.ts:1443`（模型答复）、`src/bridge.ts:1566`（桥主动发送）、`src/onebot.ts:109-111`（线边界 `sanitizeOutgoingMessage`），规则加在 `src/text.ts` 一处即可全覆盖。

**改法**（`src/text.ts`，新增 4 个常量 + 2 个函数，`sanitizeReply` 与 `stripToolSyntax` 各接一次）：

- 思考独白：`MONOLOGUE_LINE`（src/text.ts:207）识别「等等，我 / 我上一轮 / 这轮发 / 直接回。 / 直接输出文字即可 / 就回。」这类自我推演行首（允许空白、`>`、`#`、`*`、`-` 前缀）；`META_NARRATION_LINE`（src/text.ts:213）识别「用户说"……"…我回」式第三人称复述，**必须引号开头**才能命中，`用户说他在改配置，我回了个收到` 这种转述放行；`truncateMonologue`（src/text.ts:218-231）按行扫、跟踪 ``` 围栏，一旦命中就 `return lines.slice(0, index).join('\n')`——只截不 `return null`，截空后交给下游既有的静默判定。
- 控制标记：`CONTROL_MARKER`（src/text.ts:352）覆盖 `DSML` / `antml:` / `im_start` / `im_end` / `invoke` / `parameter` / `function_calls`，半角竖线与全角竖线 `｜`（U+FF5C）都认；必须以尖括号或竖线起头，否则 `src/bridge/invoke.ts` 这种路径会被吃到行尾。`BROKEN_CLOSE_TAG`（src/text.ts:355）只认「标签名后紧跟引号/反斜杠残渣」的残缺闭合标签（如 `</apc">`），不吃正常行尾。`PROTOCOL_LINE`（src/text.ts:357）把只剩协议残段的整行直接丢。三者接进 `stripToolSyntax`（src/text.ts:360-380）的行内链与整行过滤，代码块与行内反引号内不参与。
- 顺带修掉一个更老的误删：`HOST_NOTICE_BLOCK` 是 `/gi` 且不认反引号，正文里写 `` `<system_warning>` `` 时会把后面整段吃到结尾。新增 `outsideCode`（src/text.ts:318）把 ``` 围栏块与行内反引号切出去，只对普通段落跑 `HOST_NOTICE_BLOCK`（src/text.ts:327）。这条不在本次两条现象里，是用全量真实语料审计发现的既有缺陷，一并修了。

**验证**：

- `npm run typecheck` 通过；`npm run build` 通过；`npm test` → **129 tests, 129 pass, 0 fail**。
- 逐条跑真实语料（`.tmp-xb26/exact.mjs`，跑构建产物 `lib/text.js`）：turn163 整段 → `？？`；`</apc">!!!` 三连感叹号块 → `!!!\n!!!\n!!!`；全角 DSML 三连 → 只剩正文；invoke 残段 → 只剩正文；`<|im_start|>` / `<|im_end|>` 夹在正文中 → 只剩正文。
- 全量真实语料审计（`.tmp-xb26/audit.mjs`，176 条来自会话日志的 user/assistant 正文；判据是「输出是否为输入的前缀」即发生了截断）：截断 18 条 = `[[NAPCAT_SILENT]]`×5 → 空（既有规则）+ `User:` / `助手:` 伪角色行 9 条（既有规则，都是历史泄漏）+ 本次三处（turn163 80→2 字、turn170 2000→1615、turn171 105→41）。**修复前被误删的 3 条（我自己解释 `<system_warning>` 的正文）已恢复完整**。
- 反例全部原样保留：反引号里的 `<system_warning>`、代码块里的 `<system_reminder>`、`等等，你说的是哪个文件？`、`用户说他在改配置，我回了个收到`、`直接回答我就行`、`我这边接着等结果`、`a < b 且 c > d`、句中引用的 `{"should_reply":false}`、`看 src/bridge/invoke.ts 那个文件`。

**脏输入语料**：`test/leak-corpus.test.mjs` 从 DUMP 20 / KEEP 9 扩到 **DUMP 28 / KEEP 16**。本次加 8 条 DUMP（思考独白整段 / 只有说明句 / 第三人称复述、残闭合标签与行内残标签、DSML 收尾三连、invoke 残段、im_start 与 im_end），7 条 KEEP（反引号里与代码块里的宿主标签、独白特征的真问句 / 第三人称转述 / 直接回答、进度表句式、含 invoke 的路径）。

**交付**：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.26.tgz`（sha1 `819b0f94eb7b4e493ef4e2b036fd2f62efd91796`，133362 字节），已装到 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-napcat`（`npm install --legacy-peer-deps`），`diff -rq` 核对 `lib/`、`client/` 与仓库构建产物一致（无输出），安装后 `require('dsh-napcat/package.json').version` = `0.3.23-xb.26`，并用装好的 `lib/text.js` 直接跑 `sanitizeReply` 冒烟通过。commit `6322921`，已推 `origin/main`。

**未验证 / 需注意**：**没有重启 DSH，也没有在真实 QQ 里复现这两类泄漏再验证修复**——真正效果要重载插件、等模型再出现同类幻觉才能确认。`MONOLOGUE_LINE` 是高置信特征黑名单，模型换种说法（比如「先确认一下」「其实这里」开头的自我推演）仍会漏；`outsideCode` 只认单反引号且不跨行（shortcut 已在代码注释标注）。

## 云端语音情绪：Qwen-Audio-TTS 标签与 instruction（0.3.23-xb.27，2026-10-30）

**现场**：用户切了 `voiceTtsProvider: aliyun` 后，`napcat_send_voice` 的 `emotion` 参数完全无效——哭、开心、生气发出来一个调。根因是 `ttsEmotion` 八维向量只喂给本机 TTS（`src/tts.ts` 的 `emotionVector`），云端分支 `synthesizeAliyun` 压根没读它；且默认 `qwen3-tts-flash` 本身不支持情感控制。

**官方核对结论**（[非实时 TTS](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide) / [Qwen-Audio-TTS HTTP API](https://www.alibabacloud.com/help/zh/model-studio/qwen-audio-tts-http-api)）：

- 支持情感的是 `qwen-audio-3.x-tts-plus/flash`，方式是**把情感标签写进 `text`**（如 `[sad]`、`[excited]`），不需要额外参数。
- 端点也不同：`POST /api/v1/services/audio/tts/SpeechSynthesizer`。用旧的 multimodal 端点直接报 `url error, please check url！`。
- 请求体也不同：`input: { text, voice, format: 'wav', sample_rate: 24000, instruction? }`，**没有 `language_type`**。
- 音色按模型版本绑定：3.1 系带 `_v3.1`（`longanhuan_v3.1`、`longanyang_v3.1` 等），和 `qwen3-tts-flash` 的 Cherry/Nini 完全不通用（实测新模型配 Nini → `Engine error [411]`；旧模型配 `_v3.1` → `Invalid voice specified`）。

**改法**：

- `src/aliyun.ts`：新增 `TTS_AUDIO_PATH`（:29）、`AUDIO_TTS_RE = /^qwen-audio-\d+(?:\.\d+)?-tts-/i`（:34）、`EMOTION_TAGS`（:41-58，八维 + 8 个中文别名，calm/平静 刻意空串=不加标签）、`KNOWN_TAGS` 30 个官方标签（:61-67）与 `ANY_TAG_RE`（:68）。导出 `supportsEmotionTag`（:71）、`emotionTag`（:76）、`applyEmotionTag`（:95，文本已带官方标签就原样返回=幂等，普通方括号如 `[第二段]` 不算标签）。`synthesizeAliyun`（:139-178）：`emotionSupport` 决定是否加标签、**600 字上限按「标签+正文」算**（:149）、按模型选端点和 body；`audioTtsBody`（:181-186）生成 Audio-TTS 体，`instruction` 留空则不带该字段。`warnVoiceMismatch`（:102-110）对「Audio-TTS 模型配了无后缀音色」或「老模型配了 `_v3` 音色」打 warn，只提示不拦请求（官方错报比本地猜准）。
- `src/config.ts`：新增 `aliyunTtsInstruction`（接口 :96、schema :200 默认 `''`、DEFAULTS :280），描述里写清只对 `qwen-audio-3.x-tts-*` 生效。**既有默认值一个没动**——`aliyunTtsModel` 仍 `qwen3-tts-flash`，`aliyunTtsVoice` 仍 `Cherry`。
- `client/index.js`：`ALIYUN_VOICES`（:36-69）末尾追加 8 个 `［Audio-TTS］` 前缀音色；FIELDS 新增 `aliyunTtsInstruction`（:123），model/voice 两个 label 补了「要情感控制填 qwen-audio-3.1-tts-flash」「_v3.1 结尾的给 Audio-TTS 用」。
- 本机 TTS 分支（`src/tts.ts` 的 `emotionVector` / `withGpu`）**一行没动**；表情包、记忆、会话归档相关代码未触及。

**情绪映射表**：`happy/高兴 → [excited]`、`angry/生气 → [angry]`、`sad/难过 → [sad]`、`afraid/害怕 → [trembling]`、`disgusted/嫌弃 → [scornful]`、`melancholic/没劲 → [bored]`、`surprised/惊讶 → [amazed]`、`calm/平静 → 不加标签`。

**验证**：`npm run typecheck` / `npm run build` 通过；`npm test` → **135 tests, 135 pass, 0 fail**（新增 `test/aliyun-emotion.test.mjs` 6 个用例，其中表驱动一组 13 行覆盖 老模型 happy/angry 不加标签、新模型 happy/高兴→`[excited]`、sad、disgusted、calm/平静/空→不加、已含 `[sad]` 与 `[Excited]` 不重复插入、普通方括号 `[第二段]` 仍加、3.0 模型也生效；另有老模型 body 深等断言、instruction 留空不传/原样透传、音色错配只 warn、标签计入 600 上限）。既有 `test/aliyun-voice.test.mjs` 的老模型断言（multimodal 端点、`{text,voice,language_type}`）全部原样通过。

**交付**：`E:/NapCat/releases/dsh-napcat-0.3.23-xb.27.tgz`（sha1 `6f1b68fce5efb9040ba59cf8657e560dc03ed1ae`，sha256 `9b39827facc46a78f963dbafcee29695339b58bc47810d596a2c544f1eb65233`，135893 字节）。已装到 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-napcat`（旧版备份 `backup-dsh-napcat-xb.26-20261030131500`），profile `package.json` 依赖已指向新 tgz，`npm install --legacy-peer-deps` 安装，`diff -r` 核对 `lib/`、`client/` 与新包逐字节一致（无输出），`package.json` 语义一致（npm 安装时按自己的格式重排了缩进），安装后 version = `0.3.23-xb.27`，用装好的 `lib/aliyun.js` 冒烟：`supportsEmotionTag` 对新/旧模型返回 `true/false`，`applyEmotionTag('你好','happy')='[excited]你好'`、`('你好','calm')='你好'`、`('[sad]你好','happy')='[sad]你好'`，`emotionTag('嫌弃')='[scornful]'`。

**未验证 / 需注意**：**没有重启 DSH，也没有在真实 QQ 里用新模型发过语音**——真正听感要重载插件、把设置页 `aliyunTtsModel` 改成 `qwen-audio-3.1-tts-flash`、`aliyunTtsVoice` 改成 `longanhuan_v3.1` 之类之后才能确认。`.tmp-probe/` 是前序探查留下的未跟踪目录，本次未动也未提交。
