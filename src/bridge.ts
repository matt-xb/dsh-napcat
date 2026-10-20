/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type { Config } from './config.js'
import { allowAccess, chatRefOf, sessionIdForChat, type ChatRef } from './chat.js'
import type { LogLevel, OneBotConnection } from './onebot.js'
import { mentions, repliesTo, splitText, toText } from './text.js'
import type { ObEvent, ObMessageEvent, ObSegment } from './types.js'

/** 宿主注入的服务（inject 保证就绪）。 */
type HostContext = Context & { agents: AgentRegistry }

interface ChatState {
  ref: ChatRef
  agent: Agent
  dispose: () => Promise<void>
  /** 本轮已产生的助手文本（turn/end 时一次性发出）。 */
  buffer: string[]
  /** 最近一条触发了回复的消息 id（replyAsQuote 与"回复机器人也算提及"用）。 */
  lastReplyId: string
}

export interface BridgeOptions {
  ctx: Context
  config: Config
  conn: OneBotConnection
  log(level: LogLevel, message: string): void
}

export class Bridge {
  private readonly chats = new Map<string, ChatState>()
  private readonly bySession = new Map<string, string>()
  private sessionEventOff: (() => void) | undefined
  private stopped = false
  private mentionWarned = false

  constructor(private readonly opts: BridgeOptions) {}

  start(): void {
    this.stopped = false
    this.sessionEventOff = this.opts.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    this.opts.log('info', '桥已就绪（每个 QQ 会话一个 agent）')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.sessionEventOff?.()
    this.sessionEventOff = undefined
    const states = [...this.chats.values()]
    this.chats.clear()
    this.bySession.clear()
    for (const state of states) {
      try {
        await state.dispose()
      } catch {
        // 单个会话 dispose 失败不影响其它会话
      }
    }
  }

  /** 一条 OneBot 事件进站。 */
  async handleEvent(event: ObEvent): Promise<void> {
    if (this.stopped) return
    if (event.post_type !== 'message') return
    const msg = event as ObMessageEvent
    const ref = chatRefOf(msg)
    if (ref === undefined) return
    const userId = String(msg.user_id ?? '')
    const selfId = this.opts.conn.selfId

    if (this.opts.config.ignoreSelf && selfId !== '' && userId === selfId) {
      this.opts.log('debug', '忽略机器人自己的消息')
      return
    }
    if (!allowAccess(this.opts.config, ref, userId)) {
      this.opts.log('debug', '策略拒绝: ' + ref.key + ' user=' + userId)
      return
    }

    if (ref.kind === 'group' && this.opts.config.requireMention) {
      if (selfId === '') {
        if (!this.mentionWarned) {
          this.mentionWarned = true
          this.opts.log('warn', '还不知道机器人自己的 QQ（botQQ 留空且事件里没带 self_id），暂不启用 @ 门控')
        }
      } else {
        const botLastReply = this.chats.get(ref.key)?.lastReplyId ?? ''
        const hit = mentions(msg.message, selfId) || repliesTo(msg.message, botLastReply)
        if (!hit) {
          this.opts.log('debug', '群消息未 @ 机器人，跳过: ' + ref.key)
          return
        }
      }
    }

    const text = toText(msg.message, selfId)
    if (text.trim() === '') {
      this.opts.log('debug', '空文本消息，跳过: ' + ref.key)
      return
    }

    const chat = await this.ensureChat(ref)
    chat.lastReplyId = String(msg.message_id ?? '')
    this.dispatch(chat, text)
  }

  // ── 会话装配 ───────────────────────────────────────────────────────────────

  private async ensureChat(ref: ChatRef): Promise<ChatState> {
    const existing = this.chats.get(ref.key)
    if (existing !== undefined) return existing

    const agents = (this.opts.ctx as HostContext).agents
    const sessionId = makeSessionId(sessionIdForChat(ref.key))
    const meta: { cwd: string; agentPreset?: string } = { cwd: this.cwd() }
    if (this.opts.config.agentPreset !== '') meta.agentPreset = this.opts.config.agentPreset
    const agentOptions: { provider?: string; model?: string } = {}
    if (this.opts.config.provider !== '') agentOptions.provider = this.opts.config.provider
    if (this.opts.config.model !== '') agentOptions.model = this.opts.config.model

    let handle: { agent: Agent; dispose(): Promise<void> }
    try {
      handle = await agents.create({ sessionId, meta, agentOptions })
    } catch (error) {
      this.opts.log('warn', '创建会话失败（多半是同 id 已有持久化日志），改用 resume: ' + describe(error))
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions })
    }

    const state: ChatState = {
      ref,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      buffer: [],
      lastReplyId: '',
    }
    this.chats.set(ref.key, state)
    this.bySession.set(String(handle.agent.session.id), ref.key)
    this.opts.log('info', '会话就绪: ' + ref.key + ' → ' + String(handle.agent.session.id))
    return state
  }

  private cwd(): string {
    const configured = this.opts.config.workspacePath.trim()
    return configured === '' ? process.cwd() : configured
  }

  private dispatch(chat: ChatState, text: string): void {
    chat.buffer = []
    try {
      chat.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dsh-napcat' },
      }))
      this.opts.log('debug', '已投递到模型: ' + chat.ref.key + ' (' + text.length + ' 字)')
    } catch (error) {
      this.opts.log('warn', '投递失败: ' + describe(error))
      void this.sendText(chat, '⚠️ 消息没送进模型：' + describe(error))
    }
  }

  // ── 出站 ───────────────────────────────────────────────────────────────────

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopped) return
    const key = this.bySession.get(String(session.id))
    if (key === undefined) return
    const chat = this.chats.get(key)
    if (chat === undefined) return

    if (event.type === 'turn/start') {
      chat.buffer = []
      return
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data.message)
      if (text.trim() !== '') chat.buffer.push(text.trim())
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      const text = chat.buffer.join('\n').trim()
      chat.buffer = []
      if (text !== '') {
        void this.sendText(chat, text)
      } else if (reason.kind === 'error') {
        void this.sendText(chat, '⚠️ 本轮出错：' + reason.error.message)
      }
      return
    }
  }

  /** 按 splitMaxChars 分段发送（第一段可带引用）。 */
  private async sendText(chat: ChatState, text: string): Promise<void> {
    const chunks = splitText(text, this.opts.config.splitMaxChars)
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      if (chunk === undefined) continue
      const message: ObSegment[] = []
      if (index === 0 && this.opts.config.replyAsQuote && chat.lastReplyId !== '') {
        message.push({ type: 'reply', data: { id: chat.lastReplyId } })
      }
      message.push({ type: 'text', data: { text: chunk } })
      try {
        await this.opts.conn.call('send_msg', {
          message_type: chat.ref.kind,
          ...(chat.ref.kind === 'group' ? { group_id: chat.ref.id } : { user_id: chat.ref.id }),
          message,
        })
      } catch (error) {
        this.opts.log('warn', '发送失败: ' + chat.ref.key + ' — ' + describe(error))
        return
      }
    }
  }
}

/** 从助手消息里抽纯文本（工具调用等非文本段忽略）。 */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const item = part as { type?: string; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('')
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
