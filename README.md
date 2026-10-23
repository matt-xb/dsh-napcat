# dsh-napcat

> 仓库：<https://github.com/wzwei1990/dsh-napcat>
> [![ci](https://github.com/wzwei1990/dsh-napcat/actions/workflows/ci.yml/badge.svg)](https://github.com/wzwei1990/dsh-napcat/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/runzhliu/deepseek-harness) 加一个 **QQ 通道**：通过 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11 协议）把群聊/私聊消息送进 dsh 的 agent，再把回复发回 QQ。

```
QQ 用户 ──消息──> NapCat ──事件(WS)──> dsh-napcat ──> 每个会话一个 dsh agent
                                          │
QQ 用户 <──回复──── NapCat <──动作(WS)────┘   （turn/end 时把助手文本分段发回）
```

自己维护的一份实现：功能按需长，结构保持薄（连接层 / 会话桥 / 工具 / 配置四块，互不缠绕）。

**当前版本 v0.3.8**（形态参考 `dsh-onebot` / `dsh-im` / `dsh-qqbot`）。

## 功能

| 类别 | 支持 |
|---|---|
| 连接 | **forward**（本插件连 NapCat，NapCat 在别的机器上时用这个）/ **reverse**（本插件监听、NapCat 拨进来）；token 校验；断线指数退避重连 |
| 触发 | @机器人 / 回复机器人 / 关键字（`triggerKeywords`，如「小灯」）；群聊可要求必须 @ |
| 准入 | 私聊 / 群聊各自策略（`open` / `allowlist` / `disabled`）+ 白名单 |
| 会话 | **一个群/一个私聊 = 一个 dsh 会话**（`napcat-group-<群号>` / `napcat-private-<QQ>`）；会话 id 里编入 cwd 哈希，重启不换会话 |
| 分组 | 每个聊天自动建一个 **工作区**（侧边栏 `群 1103089802` / `私聊 1000001`）并挂载会话 |
| 标题 | 首条消息时把会话标题写成 `MM-DD HH:mm` |
| 性格 | 群 / 人性格：`personaOverrides`（`group:<群号>=人设` / `private:<QQ>=人设`），按会话注入 systemPrompt |
| 图片（收） | **原生送达**：下载到 `<会话cwd>/napcat-inbox/` → `attachments.admitPromptContent` → `ImageBlock` 进模型请求（视觉模型直接看图）；同时保留 `[图片: <路径>]` 文本兜底 |
| 文件（收） | 私聊三级兜底：`get_private_file_url` → `get_file` 的 base64 → `get_file` 的 http url；远端 NapCat 只给本机路径时给出明确原因 |
| 群文件（收） | 工具按需拉取：`napcat_list_group_files` / `napcat_fetch_group_file`，支持**模糊文件名**（用户只记得一部分也能匹配） |
| 引用消息 | 引用一条带图/文件的消息 @机器人，会通过 `get_msg` 取回被引用消息里的媒体 |
| 图片 / 文件（发） | `napcat_send_image`（本地路径或 URL，自动 base64，NapCat 在远端也能发）/ `napcat_send_file`（`file` 段，失败退回 `upload_*_file`） |
| 稳定性 | 复用宿主已存在的 agent；同一会话装配串行化；会话文件丢失（ENOENT）自愈并重投；归档过的会话改用 `-rN` 新会话（不擅自解除归档） |
| 审批 | QQ 侧无人可点「同意」，自动把该 agent 审批策略设为 `never`（GUI 里显示 `Custom` 属预期） |
| 诊断 | `<会话cwd>/napcat-inbox/_image-debug.log` 逐步记录收图（可随时删）；默认日志每消息仅两行 |

> 说明：**图片原生送达**要求主模型支持图片输入；无视觉的模型会收到宿主生成的占位文本 + 我们附加的路径注释，可用 `read_image` / 视觉桥工具读该路径。

## 群记忆

一个群（或一个私聊）一份长期记忆，**跨天复用**，与其它群互不干扰。

### 两层结构

| 层 | 内容 | 怎么用 |
|---|---|---|
| **热上下文** | 最近 N 条群消息（`recent.jsonl`，默认留 200 条） | 每次触发自动注入最近 20 条 → 「知道刚才在聊什么」 |
| **长期记忆** | 群设定 / 黑话 / 人物关系 / 事实结论（mnemon 记忆空间，一群一个） | 显式召回（固定层 + 按需层两次） |

### 分层标签（模型自动维护，不需要用户命令）

```
【设定】群规矩 / 称呼 / 习惯   → tags 加 setting
【黑话】群内术语 / 缩写 / 梗   → tags 加 glossary
【人物】成员身份 / 关系 / 别名 → tags 加 person
【事实】结论 / 约定 / 待办     → 无额外标签
```

- **自动捕获**：只要对话里出现上述新信息，模型自己写入（`memoryAutoCapture`，默认开）
- **更新语义**：信息变化时先 `mnemon_forget` 旧条目再写新版本（带「更新于 MM-DD」），不是只增不改
- **静默**：记忆的增/改/删都不向用户汇报过程，回复保持自然语气

### 手动入口（可选）

| 命令 | 作用 |
|---|---|
| `@机器人 记住：周五发周报` | 写一条事实 |
| `@机器人 记住设定：群里管老张叫张哥` | 写设定（也支持 `记住黑话：` / `记住人物：`） |
| `@机器人 记忆` | 检索本群长期记忆并回答 |
| `@机器人 忘掉 XXX` | 召回后软删对应条目 |

### 历史预热

缓冲不足（或最新一条已过期）时，用 NapCat 的历史接口补齐：

- 群 → `get_group_msg_history`
- 私聊 → `get_friend_msg_history`

判据是「条数够 **且** 够新」：`warmupHistory`（目标条数）、`warmupStaleMinutes`（新鲜度），不会一直抱着旧聊天。

> ⚠️ 实现要点：mnemon 的记忆操作**必须在模型本轮 turn 内**执行（插件用 `ctx.tools.execute()` 在轮次外调用会被拒绝）。所以插件只负责注入上下文 + 转投命令，**从不自己调用 mnemon 的 recall**。

## 群 / 人性格

配置 `personaOverrides`，每行一条：

```
group:<群号>=<人设>
private:<QQ>=<人设>
```

- 按会话精确匹配注入（`systemPrompt.context`），不同群可以有不同性格
- **只影响语气 / 称呼 / 风格**：不会把设定原文念给用户，也不会拿它当自我介绍（代码里有硬约束）
- 留空 = 不注入任何性格，纯工具人

## 快速开始

### 1. NapCat 侧

| 模式 | 说明 | NapCat 侧填法 |
|---|---|---|
| `forward`（推荐） | 插件主动连 NapCat 的 WS | NapCat 开 WebSocket 服务器，记下 `ws://<host>:<port>` + token |
| `reverse` | NapCat 连插件的 WS 服务 | NapCat 填 `ws://<插件所在机器>:<port>`；插件这边填 `host` / `port` / `accessToken` |

`accessToken` 两边必须一致。

### 2. 安装插件

```bash
# 从 GitHub
dsh plugin --profile web add github:wzwei1990/dsh-napcat

# 或本地目录
dsh plugin --profile web add /path/to/dsh-napcat
```

仓库已提交构建产物 `lib/`，纯安装不需要本地编译；改代码后 `pnpm build` 再重装/重启即可。

### 3. 配置

设置 → **NapCat**（顶层设置分区，order 60）。保存即时生效（配置项都是 `volatile`，插件监听 `settings/document-updated` 自己重建连接）。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `forward` | `forward`=插件连 NapCat；`reverse`=NapCat 连插件 |
| `url` | `ws://<napcat-host>:3001` | `forward` 模式下的 NapCat WS 地址 |
| `accessToken` | `''` | OneBot token（两边一致） |
| `host` / `port` | `0.0.0.0` / `3001` | `reverse` 模式下插件监听地址 |
| `botQQ` | `''` | 机器人 QQ；留空用事件里的 `self_id` |
| `adminUsers` | `[]` | 管理员 QQ（预留） |
| `dmPolicy` / `allowFrom` | `allowlist` / `[]` | 私聊策略与白名单 |
| `groupPolicy` / `groupAllowFrom` | `allowlist` / `[]` | 群策略与白名单（群文件工具也受它约束） |
| `triggerKeywords` | `[]` | 触发关键字（如 `小灯`） |
| `requireMention` | `true` | 群聊是否必须 @；关键字/回复命中则不需要 |
| `ignoreSelf` | `true` | 忽略机器人自己发的消息 |
| `replyAsQuote` | `false` | 回复时是否引用原消息 |
| `splitMaxChars` | `1200` | 长消息分段长度 |
| `reconnectMaxAttempts` | `10` | 重连次数（2s→60s 退避） |
| `perChatWorkspace` | `true` | 每个聊天一个独立工作区/分组 |
| `workspacePath` | `''` | 工作区根目录（留空=当前目录下的 `napcat/`） |
| `personaOverrides` | `''` | 群/人性格，多行 `group:<群号>=人设` / `private:<QQ>=人设` |
| `personaOverrides` | `'` | 群/人性格，多行 `group:<群号>=人设` / `private:<QQ>=人设`（只影响语气，不复述设定） |
| `memoryEnabled` | `true` | 群记忆总开关（最近对话缓冲 + 长期记忆） |
| `memoryBackend` | `mnemon` | `mnemon`=每群一个记忆空间（推荐）/ `file`=纯本地文件，完全不碰 mnemon |
| `memoryAutoCapture` | `true` | 模型自动判断并写入设定/黑话/人物/事实（关掉则只响应显式「记住」） |
| `memorySpaces` | `'` | 手填空间 id（`group:<群号>=<id>`）；留空由模型首次使用时自动创建并登记 |
| `memorySpacePrefix` | `napcat-` | 自动创建空间时的名字前缀 |
| `recentLimit` | `200` | 每群保留最近消息条数（缓冲上限，不直接进模型） |
| `injectRecent` | `20` | 每次触发注入最近对话条数（直接影响 token 成本） |
| `injectMaxChars` | `4000` | 记忆注入总字符上限（超出截断并提示压缩） |
| `warmupHistory` | `0` | 预热目标条数（0=关闭）；缓冲不足时用历史接口补齐 |
| `warmupStaleMinutes` | `10` | 缓冲最新一条超过多少分钟视为过期、需要重新预热 |
| `agentPreset` | `''` | 会话使用的 preset（留空=宿主默认） |
| `provider` / `model` | `''` | 覆盖模型（留空=宿主默认模型） |
| `logLevel` | `info` | `debug` 看投递/图片细节 |

## 工具（agent 可调用）

| 工具 | 作用 |
|---|---|
| `napcat_send_message` | 主动发文本（`private:123` / `group:456`，超长自动分段） |
| `napcat_list_targets` | 列好友与群，确定 `chat_id` |
| `napcat_send_image` | 发图片（本地路径或 URL；自动 base64） |
| `napcat_send_file` | 发文件（`file` 段 → 退回 `upload_*_file`） |
| `napcat_list_group_files` | 列群文件（`get_group_root_files` / `get_group_files_by_folder`，可按关键字过滤） |
| `napcat_fetch_group_file` | 下载群文件（**模糊文件名**；多个同分返回候选清单） |
| `napcat_api` | 白名单内的原始 OneBot 动作 |

省略 `chat_id` 时，工具默认作用于当前会话。

## 工作原理（读代码前先看这四句）

1. **一条 QQ 消息 → 一个 dsh 会话**：`chatRefOf()` 得 `group:<号>` / `private:<QQ>`，`ensureChat()` 建/恢复会话（cwd 哈希进 id）。
2. **媒体先落盘再进模型**：下载 → `attachments.admitPromptContent` → `ImageBlock`；`createUserMessage({ content: [...blocks, text] })` → `agent.followup()`。
3. **回复靠会话事件**：监听 `session/event`，`assistant/message` + `turn/end` 拼文本 → `send_msg`（按 `splitMaxChars` 分段）。
4. **分组靠工作区注册表**：`workspaceRegistry.resolveByPath/create` + `attachSession`（宿主要求工作区路径 == 会话 cwd）。

## 排错

| 现象 | 检查 |
|---|---|
| 消息没反应 | 群里是否 @ / 命中关键字；`groupAllowFrom` 是否含该群 |
| 每轮 `blocked` 没回复 | 审批策略未设成 `never`（应自动设；GUI 显示 `Custom` 属预期） |
| 图片只有路径 | 看 `napcat-inbox/_image-debug.log`：`admit ok` 表示图已进会话；无视觉模型收到占位文本属正常 |
| 收图/收文件失败 | 远端 NapCat 常只给**本机路径**（`/app/...`）→ 需开文件直链或共享目录 |
| 群文件列表失败 | 老 NapCat 用 `get_group_file_list`，新版用 `get_group_root_files`；插件两个都试，失败会列具体原因 |
| 会话重复/串台 | `workspacePath` 是否变过（变了会换会话）；归档过的会话会自动换 `-rN` |

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → lib/
pnpm test        # node --test
```

```
src/
  index.ts      插件入口（inject / apply / 设置热更新 / 人设注入）
  bridge.ts     QQ ↔ DSH 桥（会话装配、收媒体、投递、回复泵、工作区）
  onebot.ts     OneBot 连接（forward/reverse、echo RPC、退避重连）
  text.ts       消息解析、CQ 码、分段、关键字、模糊文件名、标题
  media.ts      base64 / 下载 / 收件箱 / 图片类型嗅探
  tools.ts      agent 可调工具
  config.ts     schemastery 配置（每字段 volatile）
client/
  index.js      设置页（settings.section）
```

## Roadmap

- [x] 收发文本（@ / 关键字 / 回复触发）
- [x] 每聊天独立会话 + 工作区分组
- [x] 群 / 人性格（`systemPrompt.context`）
- [x] 图片原生送达（`ImageBlock`）+ 路径兜底
- [x] 私聊文件 / 引用消息媒体 / 群文件（模糊匹配）
- [x] 会话标题、归档会话自动换新、诊断日志
- [x] **群记忆（mnemon 分层）**：热上下文缓冲 + 设定/黑话/人物/事实四层 + 自动捕获 + 更新语义 + 历史预热
- [ ] **主动发言**（定时或事件驱动，带频率与冷场控制）
- [ ] 语音消息（STT / TTS）
- [x] 发文件：`file` 段 base64 已验证可用（远端 NapCat 生效）；`upload_*_file` 仅作兜底（官方要求本地路径或 URL，base64 未文档化）

## License

MIT
