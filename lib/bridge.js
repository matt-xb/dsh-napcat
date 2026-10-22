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
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { allowAccess, chatRefOf, sessionIdForChat } from './chat.js';
import { findKeyword, mentions, parsePersonaOverrides, repliesToAny, segmentsOf, shortHash, splitText, titleFrom, toText } from './text.js';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_IMAGE_BYTES, base64UrlToBuffer, downloadToFile, ensureInbox, imageMediaType, nameFromRef } from './media.js';
import { readFile, writeFile } from 'node:fs/promises';
/** 投递后多久没收到 turn/start 就判定会话失效。 */
const WATCHDOG_MS = 10000;
export class Bridge {
    opts;
    chats = new Map();
    bySession = new Map();
    /** 归档/失效后换用新会话 id 的后缀（下次建会话时带上）。 */
    sessionSuffixes = new Map();
    /** sessionId → 该会话的人设文本（来自 personaOverrides）。 */
    personaBySession = new Map();
    /** 解析后的人设表（chat key → 文本）。 */
    personas = parsePersonaOverrides('');
    sessionEventOff;
    stopped = false;
    mentionWarned = false;
    constructor(opts) {
        this.opts = opts;
        this.refreshPersonas();
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
        const chat = await this.ensureChat(ref);
        const media = await this.resolveInboundMedia(msg, chat);
        const textWithoutImageMarkers = rawText.replace(/\[图片\]/g, '').replace(/\n{2,}/g, '\n').trim();
        const text = [textWithoutImageMarkers, ...media.notes].filter(part => part !== '').join('\n');
        if (text.trim() === '') {
            this.opts.log('debug', '空消息（无文本也没有可下载的媒体），跳过: ' + ref.key);
            return;
        }
        const sentId = String(msg.message_id ?? '');
        chat.lastReplyId = sentId;
        if (sentId !== '') {
            chat.recentReplyIds = [...(chat.recentReplyIds ?? []), sentId].slice(-30);
        }
        this.dispatch(chat, text);
    }
    /** 宿主会话 id → QQ 会话 key（工具省略 chat_id 时用来定位当前会话）。 */
    keyForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /** 把消息里的图片/文件下载到会话收件箱，返回给模型的文本注释（[图片: path]）。 */
    async resolveInboundMedia(msg, chat) {
        const media = segmentsOf(msg.message).filter(seg => seg.type === 'image' || seg.type === 'file');
        const blocks = [];
        if (media.length === 0)
            return { notes: [], blocks };
        let cwd = chat.cwd;
        if (cwd === undefined) {
            cwd = await this.cwdFor(chat.ref);
            chat.cwd = cwd;
        }
        const inbox = await ensureInbox(cwd);
        const notes = [];
        for (const seg of media) {
            const data = (seg.data ?? {});
            const fileRef = String(data.file ?? '');
            try {
                if (seg.type === 'image') {
                    const info = await this.opts.conn.call('get_image', { file: fileRef });
                    const url = info?.url;
                    if (url === undefined || url === '')
                        throw new Error('get_image 没有返回 url');
                    const saved = await downloadToFile(url, inbox, nameFromRef(fileRef, 'image.png'), DEFAULT_MAX_IMAGE_BYTES);
                    this.opts.log('info', '收到图片 → ' + saved.path + ' (' + Math.round(saved.bytes / 1024) + 'KB)');
                    // 走 DSH 原生附件：图片作为 image block 进模型请求；纯文本模型由宿主降级为占位文本
                    const buffer = await readFile(saved.path);
                    const mediaType = imageMediaType(buffer);
                    const attachments = this.opts.ctx.attachments;
                    let attached = false;
                    if (mediaType !== undefined && attachments?.saveImages !== undefined) {
                        try {
                            const refs = await attachments.saveImages([
                                { data: new Uint8Array(buffer), mediaType, name: nameFromRef(fileRef, 'image') },
                            ]);
                            const ref = refs[0];
                            if (ref !== undefined) {
                                blocks.push({ type: 'image', attachment: ref });
                                attached = true;
                            }
                        }
                        catch (error) {
                            this.opts.log('warn', '图片登记为附件失败，退回路径注释: ' + describe(error));
                        }
                    }
                    // 路径注释永远保留：无视觉模型只会拿到宿主的占位文本，路径是它们唯一的抓手；
                    // 视觉模型另外还能直接拿到 image block。
                    notes.push('[图片: ' + saved.path + ']' + (attached ? '' : '（未登记为附件，仅路径）'));
                }
                else {
                    const info = await this.opts.conn.call('get_file', { file: fileRef });
                    let savedPath;
                    if (typeof info?.base64 === 'string' && info.base64 !== '') {
                        const buffer = base64UrlToBuffer(info.base64);
                        if (buffer.byteLength > DEFAULT_MAX_FILE_BYTES)
                            throw new Error('文件超过上限');
                        savedPath = join(inbox, Date.now().toString(36) + '-' + nameFromRef(fileRef, 'file'));
                        await writeFile(savedPath, buffer);
                    }
                    else if (typeof info?.url === 'string' && info.url !== '') {
                        const saved = await downloadToFile(info.url, inbox, nameFromRef(fileRef, 'file'), DEFAULT_MAX_FILE_BYTES);
                        savedPath = saved.path;
                    }
                    if (savedPath === undefined)
                        throw new Error('get_file 既没有 base64 也没有 url');
                    this.opts.log('info', '收到文件 → ' + savedPath);
                    notes.push('[文件: ' + savedPath + ']');
                }
            }
            catch (error) {
                const reason = describe(error);
                this.opts.log('warn', '收媒体失败（' + seg.type + '）: ' + reason);
                notes.push('[' + (seg.type === 'image' ? '图片' : '文件') + ': 下载失败（' + reason + '）]');
            }
        }
        return { notes, blocks };
    }
    // ── 会话装配 ───────────────────────────────────────────────────────────────
    /** 同一聊天并发进来时只装配一次（并发 create 会撞 write handle）。 */
    pendingChats = new Map();
    ensureChat(ref) {
        const existing = this.chats.get(ref.key);
        if (existing !== undefined)
            return Promise.resolve(existing);
        const inflight = this.pendingChats.get(ref.key);
        if (inflight !== undefined)
            return inflight;
        const job = this.createChat(ref).finally(() => { this.pendingChats.delete(ref.key); });
        this.pendingChats.set(ref.key, job);
        return job;
    }
    async createChat(ref) {
        const existing = this.chats.get(ref.key);
        if (existing !== undefined)
            return existing;
        const agents = this.opts.ctx.agents;
        const cwd = await this.cwdFor(ref);
        const suffix = this.sessionSuffixes.get(ref.key);
        // 把 cwd 编进会话 id：改过 workspacePath/开关后自然换新会话，不会 resume 到旧 cwd 的半死会话
        const cwdTag = this.opts.config.perChatWorkspace && this.opts.config.workspacePath.trim() !== ''
            ? '-w' + shortHash(cwd)
            : '';
        let sessionId = makeSessionId(sessionIdForChat(ref.key) + cwdTag + (suffix === undefined ? '' : '-' + suffix));
        // 用户归档过这个会话 → 不解除归档（尊重你的意图），改用**确定性**后缀的新会话：
        // -r1、-r2… 逐个试，取第一个没被归档的。这样重启后还是同一个，不会每次换新。
        if (this.isArchived(String(sessionId))) {
            const base = sessionIdForChat(ref.key) + cwdTag;
            for (let n = 1; n <= 99; n += 1) {
                const candidate = makeSessionId(base + '-r' + n);
                if (this.isArchived(String(candidate)))
                    continue;
                sessionId = candidate;
                this.sessionSuffixes.set(ref.key, 'r' + n);
                this.opts.log('info', '会话已被归档，改用未归档的会话: ' + String(sessionId));
                break;
            }
        }
        // 宿主注册表里已有活着的 agent（上一轮装配失败/并发场景）→ 直接复用，
        // 否则 resume/create 会撞 "already owned by an active write handle" / "already exists"
        let handle;
        const liveAgent = agents.get?.(String(sessionId));
        if (liveAgent !== undefined) {
            this.opts.log('info', '复用已存在的 agent: ' + String(sessionId));
            handle = { agent: liveAgent, dispose: async () => undefined };
        }
        const meta = { cwd };
        if (this.opts.config.agentPreset !== '')
            meta.agentPreset = this.opts.config.agentPreset;
        const agentOptions = {};
        // 照 dsh-onebot：优先用宿主默认模型服务；插件配置里的 provider/model 覆盖它
        const defaultModel = this.opts.ctx.agentDefaultModel;
        let selection = defaultModel?.currentSelection?.();
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
        }
        if (this.opts.config.provider !== '')
            agentOptions.provider = this.opts.config.provider;
        if (this.opts.config.model !== '')
            agentOptions.model = this.opts.config.model;
        if (agentOptions.provider !== undefined && agentOptions.model !== undefined) {
            selection = { provider: agentOptions.provider, model: agentOptions.model, ...(selection?.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) };
        }
        const selectionRef = selection === undefined ? undefined : { current: selection, assembled: undefined };
        // setup：把预设挂进 agent 的 ctx，并安装模型选择（dsh-onebot 同款）
        const presetId = this.opts.config.agentPreset.trim() === '' ? undefined : this.opts.config.agentPreset.trim();
        const presets = this.opts.ctx.agentPresets;
        if (presets?.mount === undefined)
            this.opts.log('warn', '宿主没有 agentPresets 服务（agent 可能没有工具/loop）');
        const setup = async (agentCtx) => {
            if (presets?.mount !== undefined) {
                try {
                    const mounted = await presets.mount(agentCtx, presetId);
                    this.opts.log('debug', 'agent 已挂预设: ' + String(mounted?.id ?? presetId ?? 'default'));
                }
                catch (error) {
                    this.opts.log('warn', '挂预设失败: ' + describe(error));
                }
            }
            if (selectionRef === undefined) {
                this.opts.log('warn', '没有可用模型（agentDefaultModel 缺失或未选择），这一轮可能空跑');
            }
            else {
                installModelSelection(agentCtx, selectionRef);
                this.opts.log('debug', 'agent 模型: ' + selectionRef.current.provider + '/' + selectionRef.current.model);
            }
        };
        if (agentOptions.model === undefined) {
            this.opts.log('warn', '没有可用的模型：在「设置 → NapCat」里填 provider/model，或先给 DSH 配一个默认模型');
        }
        let created = true;
        if (handle === undefined) {
            // 照 dsh-onebot：先用 sessionPersistence.stat 探测是否已有持久化日志，避免 create 抛错
            let exists = false;
            const persistence = this.opts.ctx.sessionPersistence;
            if (persistence?.stat !== undefined) {
                try {
                    exists = (await persistence.stat(sessionId)) !== undefined;
                }
                catch {
                    exists = false;
                }
            }
            if (exists) {
                try {
                    created = false;
                    handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
                }
                catch (error) {
                    this.opts.log('warn', '预检到日志但 resume 失败，改 create: ' + describe(error));
                    created = true;
                    exists = false;
                    handle = await agents.create({ sessionId, meta, agentOptions, setup });
                }
            }
            else
                try {
                    handle = await agents.create({ sessionId, meta, agentOptions, setup });
                }
                catch (error) {
                    this.opts.log('warn', '创建会话失败（多半是同 id 已有持久化日志），改用 resume: ' + describe(error));
                    created = false;
                    handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
                }
        }
        // 照 dsh-onebot：create/resume 后必须等 agent 就绪（whenIdle）再投递消息，
        // 否则 followup 落不到正在初始化的 agent 上，表现为"消息进去了但这一轮不跑"
        try {
            await handle.agent.whenIdle();
        }
        catch (error) {
            try {
                await handle.dispose();
            }
            catch {
                // 以 whenIdle 的错误为准
            }
            throw error;
        }
        // QQ 渠道没人能点"同意"：审批策略设为 never（否则每轮 turn 会被 blocked）
        try {
            const approval = this.opts.ctx.approval;
            if (approval?.setPolicy !== undefined) {
                approval.setPolicy(handle.agent, 'never');
                this.opts.log('debug', '审批策略已设为 never（QQ 会话无法交互审批）');
            }
            else {
                this.opts.log('warn', '宿主没有 approval.setPolicy（可能仍会被审批挡住）');
            }
        }
        catch (error) {
            this.opts.log('warn', '设置审批策略失败: ' + describe(error));
        }
        const state = {
            ref,
            cwd,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            buffer: [],
            lastReplyId: '',
            recentReplyIds: [],
            fresh: created,
            turnStarted: false,
            retried: false,
        };
        this.chats.set(ref.key, state);
        this.bySession.set(String(handle.agent.session.id), ref.key);
        // 侧边栏工作区需要显式挂载会话（否则显示未分组）
        await this.attachToWorkspace(cwd, workspaceTitle(ref), handle.agent.session.id);
        this.opts.log('info', '会话就绪: ' + ref.key + ' → ' + String(handle.agent.session.id) + ' (cwd=' + cwd + ')');
        return state;
    }
    /**
     * 把会话挂进工作区：宿主要求 **工作区路径必须等于会话 cwd**，所以每个聊天目录本身就是
     * 一个工作区（一群一格 / 一人一格）。照 dsh-onebot：resolveByPath → create(path,title) → attachSession。
     */
    /** 该会话是否已被归档（归档门禁会把每一轮判成 blocked，所以要换新会话）。 */
    isArchived(sessionId) {
        try {
            const registry = this.opts.ctx.workspaceRegistry;
            const ids = registry?.archivedSessionIds ?? [];
            return ids.some(id => String(id) === sessionId);
        }
        catch {
            return false;
        }
    }
    /** 重新解析 personaOverrides（配置热更新时调用）。 */
    refreshPersonas() {
        this.personas = parsePersonaOverrides(this.opts.config.personaOverrides);
        for (const [sessionId, chatKey] of this.bySession) {
            const text = this.personas.get(chatKey);
            if (text === undefined || text === '')
                this.personaBySession.delete(sessionId);
            else
                this.personaBySession.set(sessionId, text);
        }
    }
    /** systemPrompt.context 的取值函数：按 assembly 里的 sessionId 找该会话的人设。 */
    personaText(assembly) {
        const id = assembly?.agent?.session?.id;
        if (id === undefined)
            return '';
        return this.personaBySession.get(String(id)) ?? '';
    }
    async attachToWorkspace(cwd, title, sessionId) {
        try {
            const registry = this.opts.ctx.workspaceRegistry;
            if (registry === undefined) {
                this.opts.log('warn', '宿主没有 workspaceRegistry 服务（无法挂工作区）');
                return;
            }
            let workspace = await registry.resolveByPath?.(cwd);
            if (workspace === undefined && registry.create !== undefined) {
                workspace = await registry.create(cwd, title);
                this.opts.log('info', '已创建分组（工作区）: ' + title + ' → ' + cwd);
            }
            if (workspace?.attachSession === undefined) {
                this.opts.log('warn', '工作区对象不可挂载: ' + cwd);
                return;
            }
            await workspace.attachSession(String(sessionId));
            this.opts.log('info', '会话已挂到分组: ' + String(workspace.path ?? cwd));
        }
        catch (error) {
            this.opts.log('warn', '挂工作区失败: ' + describe(error));
        }
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
    dispatch(chat, text, blocks = []) {
        chat.buffer = [];
        chat.lastText = text;
        // 每次投递前重新断言「免审批」：用户在 GUI 换过权限档位也能继续工作
        try {
            const approval = this.opts.ctx.approval;
            approval?.setPolicy?.(chat.agent, 'never');
        }
        catch {
            // 尽力而为；失败时后续仍会按原策略走
        }
        if (chat.titleSet !== true) {
            chat.titleSet = true;
            try {
                const titles = this.opts.ctx.sessionTitle;
                const named = titles?.rename?.(chat.agent.session, titleFrom(text));
                this.opts.log('debug', '会话标题: ' + String(named?.title ?? titleFrom(text)));
            }
            catch (error) {
                this.opts.log('debug', '设置会话标题失败: ' + describe(error));
            }
        }
        let pending;
        try {
            pending = chat.agent.followup(createUserMessage({
                content: [{ type: 'text', text }, ...blocks],
                source: { kind: 'plugin:dsh-napcat' },
            }));
            this.opts.log('info', '已投递到模型: ' + chat.ref.key + ' (' + text.length + ' 字)');
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
        chat.dispatchedAt = Date.now();
        // 新建的会话一般不会失效；只有 resume 回来的旧会话（可能已归档）才需要看门狗
        if (chat.fresh !== true)
            this.armWatchdog(chat, text);
    }
    /** 10s 内没等到 turn/start 就认为会话已失效（典型：会话被归档），换新会话重投一次。 */
    armWatchdog(chat, text) {
        if (chat.startTimer !== undefined)
            clearTimeout(chat.startTimer);
        chat.turnStarted = false;
        chat.startTimer = setTimeout(() => {
            chat.startTimer = undefined;
            if (this.stopped)
                return;
            const alive = chat.turnStarted === true || (chat.lastEventAt ?? 0) > (chat.dispatchedAt ?? 0);
            if (alive)
                return;
            this.opts.log('warn', '会话没有开始执行（可能已归档或失效），换新会话重投: ' + chat.ref.key);
            void this.recoverAndRetry(chat, text);
        }, WATCHDOG_MS);
    }
    /** 会话失效后：重建会话并把这条消息再投一次（每条消息只重试一次）。 */
    async recoverAndRetry(chat, text) {
        const ref = chat.ref;
        if (chat.retried === true) {
            await this.sendText(chat, '⚠️ 会话没有响应，已换新会话仍失败，请稍后再试');
            return;
        }
        await this.recoverChat(chat, new Error('会话没有开始执行'));
        try {
            const fresh = await this.ensureChat(ref);
            fresh.retried = true;
            this.dispatch(fresh, text);
        }
        catch (error) {
            this.opts.log('warn', '重建会话失败: ' + describe(error));
        }
    }
    /** 投递失败（归档/删除/agent 释放）：丢掉旧会话状态，下次消息重新建会话，并告知用户。 */
    async recoverChat(chat, error, notify = true) {
        if (chat.startTimer !== undefined) {
            clearTimeout(chat.startTimer);
            chat.startTimer = undefined;
        }
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
        if (notify)
            await this.sendText(chat, '⚠️ 消息没送进模型：' + describe(error) + '\n（会话状态已重置，再发一条会重新建会话）');
    }
    // ── 出站 ───────────────────────────────────────────────────────────────────
    onSessionEvent(session, event) {
        if (this.stopped)
            return;
        const key = this.bySession.get(String(session.id));
        if (key === undefined) {
            if (String(session.id).includes('napcat'))
                this.opts.log('debug', '事件找不到会话映射: ' + String(session.id) + ' type=' + String(event.type));
            return;
        }
        this.opts.log('debug', '出站事件: ' + String(event.type) + ' ← ' + key);
        const chat = this.chats.get(key);
        if (chat === undefined)
            return;
        // 任何事件都说明这一轮在跑（turn/start 未必总能收到）
        chat.lastEventAt = Date.now();
        if (event.type === 'turn/start') {
            chat.buffer = [];
            return;
        }
        if (event.type === 'assistant/message') {
            const text = messageText(event.data.message);
            this.opts.log('debug', '助手文本长度: ' + text.length);
            if (text.trim() !== '')
                chat.buffer.push(text.trim());
            return;
        }
        if (event.type === 'assistant/attempt') {
            const stream = event.data.stream;
            this.opts.log('warn', '一次模型尝试未提交（无正式回复）: ' + JSON.stringify(stream ?? {}).slice(0, 400));
            return;
        }
        if (event.type === 'turn/end') {
            this.opts.log('debug', 'turn/end 原因: ' + JSON.stringify(event.data.reason ?? {}).slice(0, 400));
            const reason = event.data.reason;
            const text = chat.buffer.join('\n').trim();
            chat.buffer = [];
            if (text !== '') {
                void this.sendText(chat, text);
            }
            else if (reason.kind === 'error') {
                void this.sendText(chat, '⚠️ 本轮出错：' + reason.error.message);
                // 会话存储文件被外部删掉时会 ENOENT：丢状态 + 换新 id，下一条消息自然新建日志
                if (/ENOENT|no such file/i.test(reason.error.message)) {
                    this.opts.log('warn', '会话存储文件丢失，丢弃会话状态并用新会话重投: ' + chat.ref.key);
                    const text = chat.lastText;
                    if (text !== undefined && text !== '')
                        void this.recoverAndRetry(chat, text);
                    else
                        void this.recoverChat(chat, reason.error, false);
                }
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
                this.opts.log('info', '已发送到 QQ: ' + chat.ref.key + ' (' + chunk.length + ' 字)');
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
/** 路径归一化：统一分隔符、去尾斜杠、小写（Windows 比较用）。 */
function normalizePath(input) {
    let value = input.trim().replace(/\//g, '\\');
    while (value.length > 1 && value.endsWith('\\'))
        value = value.slice(0, -1);
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
/** 工作区/分组标题：群 → 群 <号>；私聊 → 私聊 <QQ>。 */
function workspaceTitle(ref) {
    const id = ref.key.replace(/^[a-z]+[:：]/, '');
    return ref.kind === 'group' ? '群 ' + id : '私聊 ' + id;
}
