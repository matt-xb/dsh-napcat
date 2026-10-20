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

## 功能（v0.1）

| 类别 | 支持 |
|---|---|
| 连接 | **forward**（本插件连 NapCat，NapCat 在别的机器上时用这个）/ **reverse**（本插件监听、NapCat 拨进来）；token 校验；断线指数退避重连 |
| 入站 | 私聊 + 群聊、文本消息；`[图片]`/`[语音]`/`@某人` 等转成占位文本；CQ 字符串兜底解析 |
| 准入 | 私聊（仅管理员 / 任何人 / 关闭）、群聊（任何群 / 白名单 / 关闭）、管理员列表 |
| 群聊 | @机器人 才响应（可关）；"回复机器人上一条消息"也算提及 |
| 会话 | 每个 QQ 会话一个稳定 session id，重启自动 `resume` 续上下文；可指定工作区 / preset / 模型 |
| 出站 | 回合结束后发回复；按 `splitMaxChars` 自动分段；可选用"引用回复" |
| 工具 | `napcat_send_message`（主动发消息）、`napcat_list_targets`（列好友/群）、`napcat_api`（白名单内的原始 OneBot 动作） |
| 防循环 | 忽略机器人自己发的消息；群消息未 @ 不处理 |

**还没做**（有意留给后续，见文末 Roadmap）：图片/语音/文件入站、语音转写、t2i 文字图卡片、斜杠命令、录制回放。

> 需要"全家桶"（t2i 卡片、语音转写、20+ 命令、诊断包）可以直接用 [`dsh-onebot-qq`](https://github.com/mario841859784/dsh-onebot)——本项目的协议细节与若干实现思路参考了它和 [`dsh-im`](https://github.com/xmanrui/dsh-im)、[`dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)，但代码是独立写的、按自己的需求取舍。

## 快速开始

### 1. NapCat 侧（云服务器上）

NapCat 的 WebUI 里开一个 **WebSocket 服务端**（NapCat 的配置文件里叫 `websocketServers` / "WebSocket 服务器"），记下：

- 端口（如 `3001`）
- token（自己设一个强随机串）

如果想反过来让 NapCat 拨过来，就配 **"WebSocket 反向"**：上报地址填 `ws://<dsh 所在机器>:8643/`，token 与插件里一致。

> 云服务器记得放行对应端口（安全组 + 容器端口映射），并尽量只对 dsh 所在机器的 IP 开放。

### 2. 安装插件

```sh
# 从 npm（发布后）
dsh plugin --profile web add dsh-napcat

# 或从 GitHub（需要仓库里有 prepare 构建脚本）
dsh plugin --profile web add git+https://github.com/wzwei1990/dsh-napcat.git

# 或本地目录（已构建过）
dsh plugin --profile web add /path/to/dsh-napcat
```

容器里部署 dsh 的话，在容器里执行（profile 在 `$DSH_HOME` 卷里，重建镜像不丢）：

```sh
docker exec -it deepseek-harness dsh plugin --profile web add dsh-napcat
# 或者把项目拷进容器后：
docker cp ./dsh-napcat deepseek-harness:/tmp/dsh-napcat
docker exec -it deepseek-harness dsh plugin --profile web add /tmp/dsh-napcat
```

### 3. 配置

Web UI 设置页里改（推荐），或者给 profile 的 `cordis.patch.yml` 里 `dsh-napcat` 行加 `config:` 覆盖：

```yaml
- insert:
  - id: dsh-napcat
    name: 'dsh-napcat'
    config:
      mode: forward
      url: 'ws://81.70.163.182:3001'
      accessToken: '你的 token'
      adminUsers: ['你的QQ号']
      groupPolicy: allowlist
      groupAllowFrom: ['你的群号']
```

最少要配三样：`mode`+`url`（或 reverse 的 `port`）、`accessToken`、`adminUsers`（否则私聊没人能触发）。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `forward` | `forward`=连 NapCat；`reverse`=监听等 NapCat 拨入 |
| `url` | `ws://127.0.0.1:3001` | forward 目标（NapCat 在云上就写云的公网 IP） |
| `accessToken` | 空 | OneBot token；forward 作为 Bearer 发出，reverse 校验来者 |
| `host` / `port` | `127.0.0.1` / `8643` | reverse 监听；NapCat 在别的机器上必须 `host: 0.0.0.0` |
| `botQQ` | 空 | 机器人自己的 QQ；留空自动学习（影响 @ 门控） |
| `adminUsers` | `[]` | 管理员 QQ |
| `dmPolicy` | `admin` | 私聊：`admin` 仅管理员 / `open` 任何人 / `disabled` |
| `allowFrom` | `[]` | `dmPolicy=open` 时的额外白名单（空=不限） |
| `groupPolicy` | `allowlist` | 群聊：`open` / `allowlist` / `disabled` |
| `groupAllowFrom` | `[]` | 白名单群号 |
| `requireMention` | `true` | 群聊必须 @机器人（或回复它上一条消息） |
| `ignoreSelf` | `true` | 忽略机器人自己的消息 |
| `replyAsQuote` | `false` | 回复时引用原消息 |
| `splitMaxChars` | `1200` | 单条消息最大字数，超出自动分段；`0`=不分段 |
| `reconnectMaxAttempts` | `50` | forward 连续失败多少次后放弃；`0`=无限 |
| `workspacePath` | 空 | QQ 会话挂载的工作区；空=宿主 cwd |
| `agentPreset` | 空 | 挂载的 agent preset |
| `provider` / `model` | 空 | 覆盖模型（空=宿主默认） |
| `logLevel` | `info` | `debug` / `info` / `warn` |

## 工具

| 工具 | 用途 |
|---|---|
| `napcat_send_message` | 给 `private:<QQ>` 或 `group:<群号>` 主动发文本（超长自动分段，可引用某条消息） |
| `napcat_list_targets` | 列出好友与群，用来确认 chat_id |
| `napcat_api` | 直接调 OneBot 动作（白名单：发送类 + 只读类，管理类不允许） |

## 工作原理（读代码前先看这四句）

1. `src/onebot.ts`：一条 WS 连接，上行收事件、下行发动作，`echo` 对请求/回执。forward/reverse 只是"谁连谁"的区别，消息格式完全相同。
2. `src/chat.ts`：QQ 会话 → `private:<QQ>` / `group:<号>` → 稳定的 session id（`napcat-private-<QQ>`），重启后 create 失败即回退 resume。
3. `src/bridge.ts`：入站过策略/门控 → `agent.followup(createUserMessage(...))`；订阅 `session/event`，在 `turn/end` 把本轮 `assistant/message` 的文本分段发回。
4. `src/tools.ts`：给模型三个工具；`src/config.ts`：schemastery 配置（Web UI 设置页自动出表单）。

## 开发

```sh
npm i          # 会按 peerDependencies 拉 @deepseek-ai/dsh-* 的类型
npm run build  # tsc → lib/
npm run typecheck
node --test test/   # 纯逻辑单测（8 个用例）
```

- 宿主 API 面：`@deepseek-ai/dsh-agent`（`ctx.agents.create/resume` → `Agent.followup`）、`@deepseek-ai/dsh-session`（`session/event`）、`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/schemastery`（配置）。
- `engines.dsh` 当前钉在 `>=0.2.1-0 <0.3.0-0`；升级 dsh 后如果宿主 API 有变，改这里并跑一遍 typecheck。

## 排错

| 症状 | 原因 / 处理 |
|---|---|
| 连不上 / 一直重连 | forward 模式下 `url` 不通或 token 不对；看日志 `NapCat 连接错误`，先在容器里 `curl` 一下那台机的端口 |
| 日志说 token 不匹配 | NapCat 里配了 token，插件的 `accessToken` 没填或填错 |
| 群里 @ 了但没反应 | `groupPolicy` 是 `allowlist` 但群号没进 `groupAllowFrom`；或 `botQQ`/selfId 还没学到（日志会提示） |
| 私聊没人理 | `dmPolicy=admin` 且 `adminUsers` 为空/不含你 |
| 机器人自己回自己 | 关掉 `ignoreSelf` 了；保持默认 `true` |
| 回复太长被截断 | 调大 `splitMaxChars`，或确认 NapCat 没开消息长度限制 |
| 重启后上下文断了 | 看日志里是 `创建会话失败…改用 resume`；session id 会打印出来 |

## Roadmap

完整规划（当前能力清单、7 个同类项目横向对比、分阶段任务与验收标准）见
[docs/ROADMAP.md](docs/ROADMAP.md)。摘要：

| 版本 | 目标 |
|---|---|
| v0.1 | WS 通道 + 3 工具 + 单测 + CI（已发布，待真实 NapCat 联调） |
| v0.2 | 观感与稳定：👀 回执、markdown 清洗、消息去重、限流、过程消息、`/help` `/status` `/new` `/stop` |
| v0.3 | 多模态与交付：图片/文件入站出站、语音转写、t2i 卡片、引用展开 |
| v0.4 | 群记忆 + 每群 skills + 定时提醒 + 主动发言（默认关） |
| v0.5 | 设置页 UI、`/doctor` 诊断包、录制回放、HTTP 上报模式 |

**不做**：多渠道（飞书/微信/钉钉）、多账号矩阵、QQ 官方 Bot API、人格框架 —— 那些是
[`dsh-im`](https://github.com/xmanrui/dsh-im) / [`dsh-im-connect`](https://github.com/MichengAI/dsh-im-connect) /
[`dsh-onebot`](https://github.com/mario841859784/dsh-onebot) 的地盘。

## License

MIT
