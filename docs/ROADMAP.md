# dsh-napcat 规划（v0.1 → v1.0）

> 本文件包含三部分：**当前能力**、**同类项目功能调研**、**分阶段规划**。
> 调研对象：`xmanrui/dsh-im`、`MichengAI/dsh-im-connect`、`mario841859784/dsh-onebot`、
> `tencent-connect/dsh-qqbot`、`wingbire/dsh-qq-assistant`、`GuruGuru-SEU/qq-dsh-bot`、
> `liumiaoqi/maibot-team.napcat-adapter`。

---

## 一、当前能力（v0.1.0）

### 1.1 连接

| 项 | 说明 |
|---|---|
| 模式 | **forward**（插件连 NapCat 的 ws）/ **reverse**（插件监听、NapCat 拨入） |
| 鉴权 | `accessToken`；forward 以 `Authorization: Bearer` 发出，reverse 校验来者（不匹配直接 1008 关闭） |
| 重连 | forward 指数退避 2s→60s，`reconnectMaxAttempts` 上限（0=无限）；reverse 后到者接管、旧连接断开 |
| 自愈 | 连上后调 `get_login_info` 学 `selfId`；事件里的 `self_id` 也会更新 |

### 1.2 入站

| 项 | 说明 |
|---|---|
| 事件 | 只处理 `post_type=message`（notice/request/meta 忽略） |
| 会话 | 私聊 `private:<QQ>`、群聊 `group:<群号>` |
| 文本化 | 文本原样；`at`→`@QQ`/`@你`/`@全体成员`；image/record/video/file/face/mface/forward/json/xml/poke/dice/rps/music/location/contact/markdown → 占位符（`[图片]` 等） |
| CQ 兜底 | 消息段是字符串时解析 CQ 码（含 `&#91;` 等反转义） |
| 空文本 | 纯图片/纯表情消息**不进模型**（v0.3 会改） |

### 1.3 准入与门控

| 项 | 说明 |
|---|---|
| 自消息 | `ignoreSelf`（默认开） |
| 私聊 | `dmPolicy`: `admin`（仅 `adminUsers`）/ `open`（任何人，可用 `allowFrom` 收窄）/ `disabled` |
| 群聊 | `groupPolicy`: `open` / `allowlist`（`groupAllowFrom`）/ `disabled` |
| 提及 | `requireMention`（默认开）：@机器人 **或** 回复机器人上一条消息；`selfId` 未知时 fail-open 并警告一次 |

### 1.4 会话

| 项 | 说明 |
|---|---|
| 粒度 | 每个 QQ 会话一个 agent，sessionId 确定性派生：`napcat-private-<QQ>` / `napcat-group-<群号>` |
| 续接 | 先 `agents.create`，失败（同 id 已有持久化日志）自动 `agents.resume` → 重启后上下文自然续上 |
| 覆盖 | `workspacePath`（工作区）、`agentPreset`、`provider`/`model` |
| 生命周期 | 插件卸载时逐个 `dispose` |

### 1.5 出站

| 项 | 说明 |
|---|---|
| 触发 | 订阅 `session/event`：`turn/start` 清缓冲 → `assistant/message` 收集文本 → `turn/end` 发送 |
| 分段 | `splitMaxChars`（默认 1200）：优先空行 → 换行 → 句号/问号/感叹号 → 空格 → 硬切 |
| 引用 | `replyAsQuote`（默认关）：首段带 `reply` 消息段 |
| 报错 | `turn/end` 的 `reason.kind === 'error'` 时发 `⚠️ 本轮出错：<message>` |

### 1.6 工具

| 工具 | 说明 |
|---|---|
| `napcat_send_message` | 主动发文本到 `private:<QQ>` / `group:<群号>`，超长自动分段，可 `quote_message_id` |
| `napcat_list_targets` | 列好友 + 群（确认 chat_id 用） |
| `napcat_api` | 白名单内原始 OneBot 调用（发送类 + 只读类；管理类禁止） |

### 1.7 配置（22 项，均有默认值，设置页可改）

`mode` `url` `accessToken` `host` `port` `botQQ` `adminUsers` `dmPolicy` `allowFrom`
`groupPolicy` `groupAllowFrom` `requireMention` `ignoreSelf` `replyAsQuote` `splitMaxChars`
`reconnectMaxAttempts` `workspacePath` `agentPreset` `provider` `model` `logLevel`

### 1.8 明确没有的（v0.1 边界）

图片/语音/文件入站与出站、流式/过程消息、斜杠命令、队列/插话、聊天内审批、群记忆、
定时提醒、主动发言、多账号、设置页 UI、诊断包、录制回放、HTTP 上报模式。

---

## 二、同类项目功能调研

### 2.1 横向对比

| 能力 | dsh-napcat | dsh-onebot | dsh-im | dsh-im-connect | dsh-qqbot | wingbire | qq-dsh-bot |
|---|---|---|---|---|---|---|---|
| 协议 | OneBot11 | OneBot11 | 12 渠道 | 9 渠道 | QQ Bot API v2 | OneBot11 | OneBot11 |
| 渠道数 | 1 | 1 | 12 | 9 | 1 | 1 | 1 |
| 多账号 | — | — | ✅ | ✅ | — | — | — |
| 扫码绑定 | — | — | ✅ | ✅ | ✅ | — | — |
| @门控 | ✅ | ✅ | ✅ | ✅ | ✅ | 六因子 | ✅ |
| 私聊准入 | ✅ | ✅ | ✅ | ✅（待批准列表） | ✅ | — | ✅ |
| 过程消息 | — | ✅ interim | ✅ 流式卡片 | ✅ 流式/编辑 | ✅ 流式 | — | ✅ progress |
| 斜杠命令 | — | ✅ 20+ | ✅ 菜单 | ✅ 30+ | ✅ | ✅ | ✅ /status |
| 队列/插话 | — | ✅ queue/steer | ✅ | ✅ | — | — | ✅ |
| 聊天内审批 | — | ✅ | ✅ | ✅ | ✅ | — | ✅ 提案确认 |
| 图片入站 | — | ✅ | ✅ | ✅ | ✅ | ✅ 识图 | ✅ read_image |
| 图片/文件出站 | — | ✅ 5 工具 | ✅ | ✅ | ✅ | ✅ 配图/立绘 | ✅ send_image/upload |
| 语音 | — | ✅ STT | ✅ 语音交互 | — | — | ✅ TTS | ✅ 转写 |
| t2i 卡片 | — | ✅ | ✅ | — | — | ✅ 图表 | — |
| 群记忆 | — | — | ✅ 14 天记录 | ✅ | — | ✅ 群档案 | ✅ 强（MEMORY.md+topics+SQLite） |
| 每群 skills | — | — | — | — | — | — | ✅ |
| 定时提醒 | — | — | — | — | — | — | ✅ cron |
| 后台任务 | — | — | — | — | — | — | ✅ 确认制 |
| 主动发言 | — | — | — | — | — | ✅ 核心特色 | — |
| 设置页 UI | — | ✅ | ✅ | ✅ | ✅ | ✅ 本地 Web | — |
| 诊断/体检 | — | ✅ /doctor | ✅ 诊断连接 | ✅ 诊断连接 | — | ✅ 依赖体检 | ✅ /status |
| 录制回放 | — | ✅ | — | — | — | — | ✅ 历史归档 |
| 限流/审计 | — | ✅ | — | — | — | ✅ 预算熔断 | ✅ 配额 |
| 测试 | 8 | 532 | ✅ | ✅ | ✅ | 223 + 9 验收 | ✅ unittest |

### 2.2 值得借鉴的具体做法

| 做法 | 出处 | 为什么值得抄 |
|---|---|---|
| reverse 模式 token 留空拒绝启动（fail-closed） | dsh-onebot | 反向 WS 默认只监听 127.0.0.1，再加 token 才算有边界 |
| `dedupWindowSeconds`（同 message_id 窗口去重） | dsh-onebot | 断线重连会重放事件，不去重就重复回复 |
| 中间消息 + 回合末撤回 + 小结卡 | dsh-onebot | 长任务等待体验；撤回避免刷屏 |
| 出站敏感内容审计 + 主动写限流（分钟/日） | dsh-onebot | 模型可能输出危险命令或刷屏 |
| `👀` 回执（set_msg_emoji_like） | qq-dsh-bot | 零成本告诉用户"收到了"，比打字省 |
| 媒体下载的私网拒绝 + DNS 校验 + 大小/超时上限 | qq-dsh-bot / dsh-onebot | 防 SSRF；QQ 图片 URL 会过期要 refresh |
| 回复长度硬上限 + markdown 转纯文本 | qq-dsh-bot | QQ 不渲染 markdown，表格/标题会变成乱码 |
| 每群独立 workspace + DSH_HOME | qq-dsh-bot | 群之间文件/会话隔离，天然多租户 |
| 记忆用 SQLite 权威 + Markdown 视图 + 审计日志 | qq-dsh-bot | 可查、可回滚、可重建 |
| 主动发言六因子打分 + 观察期 + 逐群学习 | wingbire | 群聊里"总是回"很烦；先观察再开口 |
| 前缀缓存优化（人设逐字节相同） | wingbire | 长系统提示的缓存命中率决定成本 |
| 指令序号选择（发裸数字选菜单） | dsh-im-connect | QQ 没有按钮，序号是最自然的交互 |
| 超时补发（deferred delivery） | dsh-im-connect / dsh-onebot | 模型慢时用户以为挂了 |

---

## 三、规划

### 3.1 定位（先定不做什么）

dsh-napcat 不做"第二个 dsh-im"，也不做"第二个 dsh-onebot"。定位：

> **单账号 NapCat 的"薄而稳"通道 + 自己的两个特色：群记忆 / 主动参与。**

不做：多渠道（飞书/微信/钉钉/Slack…）、多账号矩阵、QQ 官方 Bot API、人格框架、
独立 Web 控制台（用 DSH 自己的设置页）。

理由：多渠道是 dsh-im / dsh-im-connect 的护城河，功能全餐是 dsh-onebot 的护城河；
跟它们拼功能面只会一直落后。而"群记忆 + 主动参与"这两块，现成插件里要么没有，
要么是以独立程序（不是 DSH 插件）形态存在——这是空位。

### 3.2 路线图

#### v0.2 「用得舒服」（1–2 天，低风险高感知）

| # | 功能 | 说明 | 验收 |
|---|---|---|---|
| 1 | 收到回执 | @ 到就 `set_msg_emoji_like` 打 👀，回复确认后取消；失败只 warn | 群里 @ 后 1s 内出现 👀 |
| 2 | markdown 清洗 | 标题/表格/`**`/代码围栏转纯文本，保留 URL | 回复里没有 `**`、`##`、`|---|` |
| 3 | 回复硬上限 | 单条 ≤ 1800 字符（QQ 限制），超出走分段 | 长回答不再被 QQ 截断 |
| 4 | 消息去重 | `message_id` + 5 分钟窗口，重放只处理一次 | 断线重连不重复回 |
| 5 | 每会话限流 | 默认 20 条/分钟，超限回一句提示（每窗口一次） | 刷屏被拦，命令不受限 |
| 6 | 过程消息 | 相邻两次工具调用之间发一条（节流 3s，最多 4 条，可选关） | 长任务能看到进度 |
| 7 | 四个命令 | `/help` `/status` `/new` `/stop`（仅管理员，`/stop` 走 agent 中断） | `/new` 换会话、`/status` 报连接+会话 |
| 8 | 错误提示带参考号 | 每次故障生成 `NC-<时间戳><随机>`，日志与提示一致 | 贴参考号能在日志里搜到 |

#### v0.3 「多模态 + 交付」（3–5 天）

| # | 功能 | 说明 | 验收 |
|---|---|---|---|
| 1 | 图片入站 | 下载（QQ 域名白名单 + 私网拒绝 + 16MiB/20s 上限）→ 存工作区 → 按模型能力提交附件 | 发图问"这是什么"能被描述 |
| 2 | 图片出站 | `napcat_send_image`（工作区内路径校验，≤20MiB） | "画个折线图发我"收到图 |
| 3 | 文件出站 | `napcat_send_file`（走 `upload_group_file`/`upload_private_file`） | "导出 PDF 发我"收到文件 |
| 4 | 语音入站 | 优先 NapCat 转写（`get_record`/`fetch_ptt_text`），无则 ffmpeg+whisper 可选 | 语音消息以 `[语音转写]` 进上下文 |
| 5 | t2i 卡片（可选） | >150 字渲染成图（CJK 字体），失败回退纯文本 | 长回答以图片呈现，不再被截断 |
| 6 | 引用展开 | 被回复的消息 `get_msg` 取原文拼进上下文 | 引用回复能理解"上面那条" |

#### v0.4 「记忆与主动」（1–2 周，特色）

| # | 功能 | 说明 | 验收 |
|---|---|---|---|
| 1 | 群记忆 | `MEMORY.md`（规则/索引）+ `topics/*.md` + `journal.jsonl` 审计；scope=group/personal；权限=群主/管理员或配置的管理员 | "记住本群不要说 X" 后能召回、能改、能删 |
| 2 | 每群 skills | 群独立技能目录，用 DSH 原生 filesystem skill provider | 装一个技能后下一轮生效 |
| 3 | 定时提醒 | SQLite + 5 字段 cron（Asia/Shanghai），每群 ≤10 个，失败置 paused 不自动重放 | "明天 9 点提醒开会" 到点发 |
| 4 | 主动发言（可选，默认关） | 简化六因子（@/点名/问号/关键词/连续性/群活跃）+ 观察期（前 80 条只判定不发）+ 逐群阈值 | 默认关；开启后不刷屏、被点名必回 |
| 5 | 群历史摘要 | 滚动保留 N 天，供"总结下今天群里聊了啥" | 能按日期/关键词查 |

#### v0.5 「工程化」（按需）

| # | 功能 | 说明 |
|---|---|---|
| 1 | 设置页 UI | host-plane settings remote + 表单（免手改 yaml） |
| 2 | 诊断包 | `/doctor` + 导出 zip（配置脱敏 + 最近错误 + 连接状态） |
| 3 | 录制/回放 | `napcat-inbox.jsonl` + `replay` 脚本（离线喂真实管线） |
| 4 | HTTP 上报模式 | 兼容只开 HTTP 的 OneBot 实现 |
| 5 | 多账号 | 仅当真有第二个号才做（配置结构要提前留好） |

### 3.3 优先级理由

- **v0.2 先做**：全是低风险高感知项，且不引入新依赖；👀/markdown/去重/限流四项加起来
  就能把"像不像个正经机器人"的观感拉满。
- **v0.3 次之**：图片是 QQ 场景最高频的输入，文件回传是"能干活"的标志；但涉及下载安全
  与宿主附件 API，必须一次做对。
- **v0.4 是差异化**：群记忆和主动参与决定"这个机器人值不值得留在群里"，也是别人没做的空位。
- **v0.5 最后**：体验包装，等功能稳定再做。

### 3.4 安全底线（每版都要过）

- reverse 模式 token 为空 → 拒绝启动（或至少拒绝非回环连接）
- 媒体下载：只允许 QQ 域名、拒绝私网/保留地址、校验重定向、限大小与超时
- 不在日志/回复里出现 token、API key
- 群白名单 + 私聊准入 + 主动写限流（分钟/日）
- 文件发送只允许当前工作区内的真实文件（拒绝符号链接逃逸）
- 记忆/技能写入要有权限校验，skill 内容不获得执行权限

### 3.5 与宿主（DSH）的兼容策略

- `engines.dsh` 钉 `>=0.2.1-0 <0.3.0-0`；升级宿主先跑 `npm run typecheck` + CI 矩阵
- 只用稳定面：`ctx.agents` / `session/event` / `createUserMessage` / `defineTool` / `schemastery`
- 需要宿主新 API（审批、附件）时，先做能力探测，缺了就降级而不是崩

---

## 四、里程碑

| 版本 | 目标 | 状态 |
|---|---|---|
| v0.1.0 | WS 通道跑通 + 3 工具 + 8 单测 + CI | ✅ 已发布到 GitHub，**待真实 NapCat 联调** |
| v0.2.0 | 观感与稳定性（回执/markdown/去重/限流/过程消息/命令） | 计划中 |
| v0.3.0 | 多模态与交付（图片/文件/语音/t2i） | 计划中 |
| v0.4.0 | 群记忆 + 定时 + 主动发言 | 计划中 |
| v0.5.0 | 设置页/诊断/回放 | 按需 |
