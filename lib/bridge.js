/**
 * QQ 会话 ↔ dsh agent 的桥。
 *
 * 入站：OneBot 消息事件 → 策略/门控 → 每个会话一个 agent → `agent.followup(用户消息)`
 * 出站：订阅会话事件（`session/event`）→ 回合结束时把助手文本按长度分段发回 QQ
 *
 * 会话 id 由 QQ 会话确定性地派生（`napcat-private-<QQ>` / `napcat-group-<群号>`），
 * 重启后 create 失败即回退 resume，于是同一 QQ 会话自动续上上下文。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { allowAccess, chatRefOf, sessionIdForChat } from './chat.js';
import { findKeyword, mentions, repliesToAny, splitText, toText } from './text.js';
export class Bridge {
    opts;
    chats = new Map();
    bySession = new Map();
    /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
    sessionSuffixes = new Map();
    sessionEventOff;
    stopped = false;
    mentionWarned = false;
    constructor(opts) {
        this.opts = opts;
    }
    start() {
        this.stopped = false;
        this.sessionEventOff = this.opts.ctx.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        this.opts.log('info', '桥已就绪（每个 QQ 会话一个 agent）');
    }
    async stop() {
        this.stopped = true;
        this.sessionEventOff?.();
        this.sessionEventOff = undefined;
        const states = [...this.chats.values()];
        this.chats.clear();
        this.bySession.clear();
        for (const state of states) {
            try {
                await state.dispose();
            }
            catch {
                // 单个会话 dispose 失败不影响其它会话
            }
        }
    }
    /** 一条 OneBot 事件进站。 */
    async handleEvent(event) {
        if (this.stopped)
            return;
        if (event.post_type !== 'message')
            return;
        const msg = event;
        const ref = chatRefOf(msg);
        if (ref === undefined)
            return;
        const userId = String(msg.user_id ?? '');
        const selfId = this.opts.conn.selfId;
        if (this.opts.config.ignoreSelf && selfId !== '' && userId === selfId) {
            this.opts.log('debug', '忽略机器人自己的消息');
            return;
        }
        if (!allowAccess(this.opts.config, ref, userId)) {
            this.opts.log('debug', '策略拒绝: ' + ref.key + ' user=' + userId);
            return;
        }
        const rawText = toText(msg.message, selfId);
        const keyword = findKeyword(rawText, this.opts.config.triggerKeywords);
        if (ref.kind === 'group' && this.opts.config.requireMention) {
            if (selfId === '') {
                if (!this.mentionWarned) {
                    this.mentionWarned = true;
                    this.opts.log('warn', '还不知道机器人自己的 QQ（botQQ 留空且事件里没带 self_id），暂不启用 @ 门控');
                }
            }
            else {
                const recent = this.chats.get(ref.key)?.recentReplyIds ?? [];
                const hit = mentions(msg.message, selfId) || repliesToAny(msg.message, recent) || keyword !== undefined;
                if (!hit) {
                    this.opts.log('debug', '群消息未 @ 机器人且没命中关键字，跳过: ' + ref.key);
                    return;
                }
            }
        }
        const text = rawText;
        if (text.trim() === '') {
            this.opts.log('debug', '空文本消息，跳过: ' + ref.key);
            return;
        }
        const chat = await this.ensureChat(ref);
        const sentId = String(msg.message_id ?? '');
        chat.lastReplyId = sentId;
        if (sentId !== '') {
            chat.recentReplyIds = [...(chat.recentReplyIds ?? []), sentId].slice(-30);
        }
        this.dispatch(chat, text);
    }
    // ── 会话装配 ───────────────────────────────────────────────────────────────
    async ensureChat(ref) {
        const existing = this.chats.get(ref.key);
        if (existing !== undefined)
            return existing;
        const agents = this.opts.ctx.agents;
        const suffix = this.sessionSuffixes.get(ref.key);
        const sessionId = makeSessionId(suffix === undefined ? sessionIdForChat(ref.key) : sessionIdForChat(ref.key) + '-' + suffix);
        const meta = { cwd: await this.cwdFor(ref) };
        if (this.opts.config.agentPreset !== '')
            meta.agentPreset = this.opts.config.agentPreset;
        const agentOptions = {};
        if (this.opts.config.provider !== '')
            agentOptions.provider = this.opts.config.provider;
        if (this.opts.config.model !== '')
            agentOptions.model = this.opts.config.model;
        // 没显式配置模型时用宿主的默认模型（否则 agent 的 {{model}} 为空，整轮会报错）
        if (agentOptions.provider === undefined || agentOptions.model === undefined) {
            const fallback = this.opts.ctx.get?.('agentDefaultModel');
            const selection = fallback?.currentSelection?.();
            if (agentOptions.provider === undefined && selection?.provider !== undefined)
                agentOptions.provider = selection.provider;
            if (agentOptions.model === undefined && selection?.model !== undefined)
                agentOptions.model = selection.model;
            if (agentOptions.reasoningEffort === undefined && selection?.reasoningEffort !== undefined)
                agentOptions.reasoningEffort = selection.reasoningEffort;
        }
        if (agentOptions.model === undefined) {
            this.opts.log('warn', '没有可用的模型：在「设置 → NapCat」里填 provider/model，或先给 DSH 配一个默认模型');
        }
        let handle;
        try {
            handle = await agents.create({ sessionId, meta, agentOptions });
        }
        catch (error) {
            this.opts.log('warn', '创建会话失败（多半是同 id 已有持久化日志），改用 resume: ' + describe(error));
            handle = await agents.resume({ resumeSessionId: sessionId, agentOptions });
        }
        const state = {
            ref,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            buffer: [],
            lastReplyId: '',
            recentReplyIds: [],
        };
        this.chats.set(ref.key, state);
        this.bySession.set(String(handle.agent.session.id), ref.key);
        this.opts.log('info', '会话就绪: ' + ref.key + ' → ' + String(handle.agent.session.id));
        return state;
    }
    /** 会话工作目录：开了 perChatWorkspace 时每个 QQ 会话一个子目录（侧边栏按工作区归拢）。 */
    async cwdFor(ref) {
        const base = this.opts.config.workspacePath.trim();
        if (base === '')
            return process.cwd();
        if (!this.opts.config.perChatWorkspace)
            return base;
        const safe = ref.key.replace(/[^A-Za-z0-9._-]+/g, '-');
        const dir = join(base, 'napcat', safe);
        try {
            await mkdir(dir, { recursive: true });
        }
        catch (error) {
            this.opts.log('warn', '创建会话目录失败，退回工作区根目录: ' + describe(error));
            return base;
        }
        return dir;
    }
    dispatch(chat, text) {
        chat.buffer = [];
        let pending;
        try {
            pending = chat.agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'plugin:dsh-napcat' },
            }));
            this.opts.log('debug', '已投递到模型: ' + chat.ref.key + ' (' + text.length + ' 字)');
        }
        catch (error) {
            this.opts.log('warn', '投递失败: ' + describe(error));
            void this.recoverChat(chat, error);
            return;
        }
        // followup 可能是异步的（会话被归档/删除、agent 已释放时会 reject）——必须接住，否则消息静默丢失
        if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
            void pending.catch((error) => {
                this.opts.log('warn', '投递被拒: ' + describe(error));
                void this.recoverChat(chat, error);
            });
        }
    }
    /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
    async recoverChat(chat, error) {
        // 换一个会话 id：否则 create 会撞上归档/失效的旧 id，又 resume 回那个死会话
        this.sessionSuffixes.set(chat.ref.key, Date.now().toString(36));
        this.chats.delete(chat.ref.key);
        for (const [sid, key] of [...this.bySession]) {
            if (key === chat.ref.key)
                this.bySession.delete(sid);
        }
        try {
            await chat.dispose();
        }
        catch {
            // agent 可能已被宿主释放，忽略
        }
        await this.sendText(chat, '⚠️ 消息没送进模型：' + describe(error) + '\n（会话状态已重置，再发一条会重新建会话）');
    }
    // ── 出站 ───────────────────────────────────────────────────────────────────
    onSessionEvent(session, event) {
        if (this.stopped)
            return;
        const key = this.bySession.get(String(session.id));
        if (key === undefined)
            return;
        const chat = this.chats.get(key);
        if (chat === undefined)
            return;
        if (event.type === 'turn/start') {
            chat.buffer = [];
            return;
        }
        if (event.type === 'assistant/message') {
            const text = messageText(event.data.message);
            if (text.trim() !== '')
                chat.buffer.push(text.trim());
            return;
        }
        if (event.type === 'turn/end') {
            const reason = event.data.reason;
            const text = chat.buffer.join('\n').trim();
            chat.buffer = [];
            if (text !== '') {
                void this.sendText(chat, text);
            }
            else if (reason.kind === 'error') {
                void this.sendText(chat, '⚠️ 本轮出错：' + reason.error.message);
            }
            return;
        }
    }
    /** 按 splitMaxChars 分段发送（第一段可带引用）。 */
    async sendText(chat, text) {
        const chunks = splitText(text, this.opts.config.splitMaxChars);
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (chunk === undefined)
                continue;
            const message = [];
            if (index === 0 && this.opts.config.replyAsQuote && chat.lastReplyId !== '') {
                message.push({ type: 'reply', data: { id: chat.lastReplyId } });
            }
            message.push({ type: 'text', data: { text: chunk } });
            try {
                await this.opts.conn.call('send_msg', {
                    message_type: chat.ref.kind,
                    ...(chat.ref.kind === 'group' ? { group_id: chat.ref.id } : { user_id: chat.ref.id }),
                    message,
                });
            }
            catch (error) {
                this.opts.log('warn', '发送失败: ' + chat.ref.key + ' — ' + describe(error));
                return;
            }
        }
    }
}
/** 从助手消息里抽纯文本（工具调用等非文本段忽略）。 */
function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const part of content) {
        const item = part;
        if (item.type === 'text' && typeof item.text === 'string')
            parts.push(item.text);
    }
    return parts.join('');
}
function describe(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
