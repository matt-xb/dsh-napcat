/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
/** 宿主 AgentRegistry.create 接受的模型选项（避免自己猜 ReasoningEffortId 的品牌类型）。 */
type AgentOptions = NonNullable<NonNullable<Parameters<AgentRegistry['create']>[0]>['agentOptions']>
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type { Config } from './config.js'
import { allowAccess, chatRefOf, sessionIdForChat, type ChatRef } from './chat.js'
import type { LogLevel, OneBotConnection } from './onebot.js'
import { findKeyword, mentions, repliesTo, repliesToAny, shortHash, splitText, toText } from './text.js'
import type { ObEvent, ObMessageEvent, ObSegment } from './types.js'

/** 宿主注入的服务（inject 保证就绪）。 */
type HostContext = Context & { agents: AgentRegistry }

/** 投递后多久没收到 turn/start 就判定会话失效。 */
const WATCHDOG_MS = 10000

interface ChatState {
  ref: ChatRef
  agent: Agent
  dispose: () => Promise<void>
  /** 本轮已产生的助手文本（turn/end 时一次性发出）。 */
  buffer: string[]
  /** 最近一条触发了回复的消息 id（replyAsQuote 与"回复机器人也算提及"用）。 */
  lastReplyId: string
  /** 机器人最近发出的消息 id（用于判定「回复机器人」，最多 30 条） */
  recentReplyIds?: string[]
  /** 本轮是否已经收到 turn/start（看门狗判定用）。 */
  turnStarted?: boolean
  /** 投递后的看门狗定时器。 */
  startTimer?: ReturnType<typeof setTimeout>
  /** true=本次是新建的会话；false=resume 的旧会话（可能已归档，需要看门狗）。 */
  fresh?: boolean
  /** 本条消息投递时刻（看门狗判定存活用）。 */
  dispatchedAt?: number
  /** 这个会话最近一次收到任何事件的时刻。 */
  lastEventAt?: number
  /** 这条消息是否已经重试过一次。 */
  retried?: boolean
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
  /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
  private readonly sessionSuffixes = new Map<string, string>()
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

    const rawText = toText(msg.message, selfId)
    const keyword = findKeyword(rawText, this.opts.config.triggerKeywords)

    if (ref.kind === 'group' && this.opts.config.requireMention) {
      if (selfId === '') {
        if (!this.mentionWarned) {
          this.mentionWarned = true
          this.opts.log('warn', '还不知道机器人自己的 QQ（botQQ 留空且事件里没带 self_id），暂不启用 @ 门控')
        }
      } else {
        const recent = this.chats.get(ref.key)?.recentReplyIds ?? []
        const hit = mentions(msg.message, selfId) || repliesToAny(msg.message, recent) || keyword !== undefined
        if (!hit) {
          this.opts.log('debug', '群消息未 @ 机器人且没命中关键字，跳过: ' + ref.key)
          return
        }
      }
    }

    const text = rawText
    if (text.trim() === '') {
      this.opts.log('debug', '空文本消息，跳过: ' + ref.key)
      return
    }

    const chat = await this.ensureChat(ref)
    const sentId = String(msg.message_id ?? '')
    chat.lastReplyId = sentId
    if (sentId !== '') {
      chat.recentReplyIds = [...(chat.recentReplyIds ?? []), sentId].slice(-30)
    }
    this.dispatch(chat, text)
  }

  // ── 会话装配 ───────────────────────────────────────────────────────────────

  private async ensureChat(ref: ChatRef): Promise<ChatState> {
    const existing = this.chats.get(ref.key)
    if (existing !== undefined) return existing

    const agents = (this.opts.ctx as HostContext).agents
    const cwd = await this.cwdFor(ref)
    const suffix = this.sessionSuffixes.get(ref.key)
    // 把 cwd 编进会话 id：改过 workspacePath/开关后自然换新会话，不会 resume 到旧 cwd 的半死会话
    const cwdTag = this.opts.config.perChatWorkspace && this.opts.config.workspacePath.trim() !== ''
      ? '-w' + shortHash(cwd)
      : ''
    const sessionId = makeSessionId(
      sessionIdForChat(ref.key) + cwdTag + (suffix === undefined ? '' : '-' + suffix),
    )
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (this.opts.config.agentPreset !== '') meta.agentPreset = this.opts.config.agentPreset
    const agentOptions: AgentOptions = {}
    if (this.opts.config.provider !== '') agentOptions.provider = this.opts.config.provider
    if (this.opts.config.model !== '') agentOptions.model = this.opts.config.model
    // 没显式配置模型时用宿主的默认模型（否则 agent 的 {{model}} 为空，整轮会报错）
    if (agentOptions.provider === undefined || agentOptions.model === undefined) {
      const fallback = (this.opts.ctx as unknown as {
        get?(name: string): { currentSelection?(): { provider?: string; model?: string; reasoningEffort?: string } } | undefined
      }).get?.('agentDefaultModel')
      const selection = fallback?.currentSelection?.()
      if (agentOptions.provider === undefined && selection?.provider !== undefined) agentOptions.provider = selection.provider
      if (agentOptions.model === undefined && selection?.model !== undefined) agentOptions.model = selection.model
      if (agentOptions.reasoningEffort === undefined && selection?.reasoningEffort !== undefined) agentOptions.reasoningEffort = selection.reasoningEffort as AgentOptions['reasoningEffort']
    }
    if (agentOptions.model === undefined) {
      this.opts.log('warn', '没有可用的模型：在「设置 → NapCat」里填 provider/model，或先给 DSH 配一个默认模型')
    }

    let handle: { agent: Agent; dispose(): Promise<void> }
    let created = true
    try {
      handle = await agents.create({ sessionId, meta, agentOptions })
    } catch (error) {
      this.opts.log('warn', '创建会话失败（多半是同 id 已有持久化日志），改用 resume: ' + describe(error))
      created = false
      handle = await agents.resume({ resumeSessionId: sessionId, agentOptions })
    }

    const state: ChatState = {
      ref,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      buffer: [],
      lastReplyId: '',
      recentReplyIds: [],
      fresh: created,
      turnStarted: false,
      retried: false,
    }
    this.chats.set(ref.key, state)
    this.bySession.set(String(handle.agent.session.id), ref.key)
    // 侧边栏工作区需要显式挂载会话（否则显示未分组）
    await this.attachToWorkspace(cwd, handle.agent.session.id)
    this.opts.log('info', '会话就绪: ' + ref.key + ' → ' + String(handle.agent.session.id) + ' (cwd=' + cwd + ')')
    return state
  }

  /** 把会话挂到 cwd 所在的工作区（workspaceRegistry.attachSession），侧边栏就不再是"未分组"。 */
  private async attachToWorkspace(cwd: string, sessionId: unknown): Promise<void> {
    try {
      const registry = (this.opts.ctx as unknown as {
        get?(name: string): { list?(): { path?: string; attachSession?(id: never): Promise<void> }[] } | undefined
      }).get?.('workspaceRegistry')
      const workspaces = registry?.list?.() ?? []
      const normalized = cwd.replace(/[\\/]+$/, '')
      let best: { path?: string; attachSession?(id: never): Promise<void> } | undefined
      for (const workspace of workspaces) {
        const path = String(workspace.path ?? '').replace(/[\\/]+$/, '')
        if (path === '') continue
        const hit = normalized === path || normalized.startsWith(path + '\\') || normalized.startsWith(path + '/')
        if (hit && (best === undefined || path.length > String(best.path ?? '').length)) best = workspace
      }
      if (best?.attachSession === undefined) {
        this.opts.log('debug', '没有匹配的工作区（可把 ' + normalized + ' 加为工作区）')
        return
      }
      await best.attachSession(String(sessionId) as never)
      this.opts.log('info', '会话已挂到工作区: ' + String(best.path))
    } catch (error) {
      this.opts.log('debug', '挂工作区失败（忽略）: ' + describe(error))
    }
  }
  /** 会话工作目录：开了 perChatWorkspace 时每个 QQ 会话一个子目录（侧边栏按工作区归拢）。 */
  private async cwdFor(ref: ChatRef): Promise<string> {
    const base = this.opts.config.workspacePath.trim()
    if (base === '') return process.cwd()
    if (!this.opts.config.perChatWorkspace) return base
    const safe = ref.key.replace(/[^A-Za-z0-9._-]+/g, '-')
    const dir = join(base, 'napcat', safe)
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      this.opts.log('warn', '创建会话目录失败，退回工作区根目录: ' + describe(error))
      return base
    }
    return dir
  }

  private dispatch(chat: ChatState, text: string): void {
    chat.buffer = []
    let pending: unknown
    try {
      pending = chat.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dsh-napcat' },
      }))
      this.opts.log('debug', '已投递到模型: ' + chat.ref.key + ' (' + text.length + ' 字)')
    } catch (error) {
      this.opts.log('warn', '投递失败: ' + describe(error))
      void this.recoverChat(chat, error)
      return
    }
    // followup 可能是异步的（会话被归档/删除、agent 已释放时会 reject）——必须接住，否则消息静默丢失
    if (pending !== null && typeof pending === 'object' && typeof (pending as { then?: unknown }).then === 'function') {
      void (pending as Promise<unknown>).catch((error: unknown) => {
        this.opts.log('warn', '投递被拒: ' + describe(error))
        void this.recoverChat(chat, error)
      })
    }
    chat.dispatchedAt = Date.now()
    // 新建的会话一般不会失效；只有 resume 回来的旧会话（可能已归档）才需要看门狗
    if (chat.fresh !== true) this.armWatchdog(chat, text)
  }

  /** 10s 内没等到 turn/start 就认为会话已失效（典型：会话被归档），换新会话重投一次。 */
  private armWatchdog(chat: ChatState, text: string): void {
    if (chat.startTimer !== undefined) clearTimeout(chat.startTimer)
    chat.turnStarted = false
    chat.startTimer = setTimeout(() => {
      chat.startTimer = undefined
      if (this.stopped) return
      const alive = chat.turnStarted === true || (chat.lastEventAt ?? 0) > (chat.dispatchedAt ?? 0)
      if (alive) return
      this.opts.log('warn', '会话没有开始执行（可能已归档或失效），换新会话重投: ' + chat.ref.key)
      void this.recoverAndRetry(chat, text)
    }, WATCHDOG_MS)
  }

  /** 会话失效后：重建会话并把这条消息再投一次（每条消息只重试一次）。 */
  private async recoverAndRetry(chat: ChatState, text: string): Promise<void> {
    const ref = chat.ref
    if (chat.retried === true) {
      await this.sendText(chat, '⚠️ 会话没有响应，已换新会话仍失败，请稍后再试')
      return
    }
    await this.recoverChat(chat, new Error('会话没有开始执行'))
    try {
      const fresh = await this.ensureChat(ref)
      fresh.retried = true
      this.dispatch(fresh, text)
    } catch (error) {
      this.opts.log('warn', '重建会话失败: ' + describe(error))
    }
  }

  /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
  private async recoverChat(chat: ChatState, error: unknown): Promise<void> {
    if (chat.startTimer !== undefined) {
      clearTimeout(chat.startTimer)
      chat.startTimer = undefined
    }
    // 换一个会话 id：否则 create 会撞上归档/失效的旧 id，又 resume 回那个死会话
    this.sessionSuffixes.set(chat.ref.key, Date.now().toString(36))
    this.chats.delete(chat.ref.key)
    for (const [sid, key] of [...this.bySession]) {
      if (key === chat.ref.key) this.bySession.delete(sid)
    }
    try {
      await chat.dispose()
    } catch {
      // agent 可能已被宿主释放，忽略
    }
    await this.sendText(chat, '⚠️ 消息没送进模型：' + describe(error) + '\n（会话状态已重置，再发一条会重新建会话）')
  }
  // ── 出站 ───────────────────────────────────────────────────────────────────

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (this.stopped) return
    const key = this.bySession.get(String(session.id))
    if (key === undefined) return
    const chat = this.chats.get(key)
    if (chat === undefined) return
    // 任何事件都说明这一轮在跑（turn/start 未必总能收到）
    chat.lastEventAt = Date.now()

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
