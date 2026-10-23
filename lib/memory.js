/** 群/私聊记忆：一群一目录隔离 + 最近消息缓冲；长期记忆走 mnemon（失败则落本地 notes.md）。 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const RECENT_FILE = 'recent.jsonl';
const SPACE_FILE = 'space.json';
const NOTES_FILE = 'notes.md';
/** 从任意返回值里捞出文本（工具结果结构可能变，尽量宽松）。 */
function collectText(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined)
        return '';
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map(item => collectText(item, depth + 1)).filter(part => part !== '').join('\n');
    if (typeof value === 'object') {
        const record = value;
        for (const key of ['text', 'content', 'value', 'result']) {
            if (record[key] !== undefined) {
                const text = collectText(record[key], depth + 1);
                if (text !== '')
                    return text;
            }
        }
    }
    return '';
}
/** 从工具返回值里递归找 memoryBodyId / id（先试 JSON，再退回正则）。 */
function findId(raw) {
    const walk = (value, depth = 0) => {
        if (depth > 6 || value === null || value === undefined)
            return undefined;
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = walk(item, depth + 1);
                if (found !== undefined)
                    return found;
            }
            return undefined;
        }
        if (typeof value === 'object') {
            const record = value;
            for (const key of ['memoryBodyId', 'memoryBody', 'id']) {
                const candidate = record[key];
                if (typeof candidate === 'string' && candidate !== '')
                    return candidate;
            }
            for (const nested of Object.values(record)) {
                const found = walk(nested, depth + 1);
                if (found !== undefined)
                    return found;
            }
        }
        return undefined;
    };
    try {
        const found = walk(JSON.parse(raw));
        if (found !== undefined)
            return found;
    }
    catch {
        // 不是 JSON，退回正则
    }
    const match = /"memoryBodyId"\s*:\s*"([^"]+)"/.exec(raw) ?? /"id"\s*:\s*"([^"]+)"/.exec(raw);
    return match?.[1];
}
/** 从空间目录文本里按名字找 id（JSON 优先，失败退回正则）。 */
function findIdByName(raw, name) {
    try {
        const parsed = JSON.parse(raw);
        const found = parsed.items?.find(item => item.name === name);
        if (found?.id !== undefined && found.id !== '')
            return found.id;
    }
    catch {
        // 不是 JSON
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp('"id"\\s*:\\s*"([^"]+)"\\s*,\\s*"name"\\s*:\\s*"' + escaped + '"').exec(raw);
    return match?.[1];
}
/** 解析 group:<群号>=<id> 多行配置。 */
export function parseSpaceMap(raw) {
    const map = {};
    for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*(group|private):(\d+)\s*=\s*(\S+)\s*$/.exec(line);
        if (match !== null)
            map[match[1] + ':' + match[2]] = match[3];
    }
    return map;
}
export class MemoryStore {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    /** 每个聊天一个目录：memory/group-<号> / memory/private-<QQ> */
    dirFor(chatKey) {
        return join(this.opts.root, chatKey.replace(':', '-'));
    }
    async ensureDir(chatKey) {
        const dir = this.dirFor(chatKey);
        await mkdir(dir, { recursive: true });
        return dir;
    }
    /** 用注册表直接调工具（插件掌握时机，不依赖模型）。 */
    async callTool(name, args, agent) {
        const registry = this.opts.ctx?.tools;
        if (registry?.execute === undefined)
            throw new Error('宿主没有 tools.execute');
        const result = await registry.execute({
            callId: 'napcat-mem-' + Date.now().toString(36),
            name,
            arguments: args,
            agent,
            // 宿主 prepareExecution 会读 exec.signal.aborted，不传就抛 TypeError
            signal: new AbortController().signal,
        });
        return collectText(result);
    }
    /** 把工具原始返回写进 _debug.log（排查解析问题用）。 */
    dumpRaw(label, raw) {
        void mkdir(this.opts.root, { recursive: true })
            .then(() => appendFile(join(this.opts.root, '_debug.log'), new Date().toISOString() + ' [' + label + '] ' + raw.slice(0, 800).replace(/\s+/g, ' ') + '\n', 'utf8'))
            .catch(() => undefined);
    }
    /** 记忆相关失败：warn 到控制台 + 追加到 memory/_debug.log，便于事后定位。 */
    reportFailure(what, error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.opts.log('warn', what + ': ' + reason);
        void mkdir(this.opts.root, { recursive: true })
            .then(() => appendFile(join(this.opts.root, '_debug.log'), new Date().toISOString() + ' ' + what + ': ' + reason + '\n', 'utf8'))
            .catch(() => undefined);
    }
    /** 拿到（或创建）本聊天的 mnemon 空间 id；失败返回 undefined（自动退化为文件记忆）。 */
    async ensureSpace(chatKey, agent) {
        if (this.opts.backend === 'file')
            return undefined;
        // mnemon 的记忆操作要求"本轮 turn 的 View"，插件在轮次外调用会被拒 →
        // 空间 id 必须由用户在配置里给出（memorySpaces），插件不再自己创建/查询。
        const configured = parseSpaceMap(this.opts.spaces ?? '')[chatKey];
        if (configured !== undefined && configured !== '')
            return configured;
        try {
            const cached = JSON.parse(await readFile(join(this.dirFor(chatKey), SPACE_FILE), 'utf8'));
            if (typeof cached.id === 'string' && cached.id !== '')
                return cached.id;
        }
        catch {
            // 无缓存
        }
        return undefined;
        try {
            const dir = await this.ensureDir(chatKey);
            return undefined;
        }
        catch (error) {
            this.reportFailure('记忆空间不可用，退化为本地笔记', error);
            return undefined;
        }
    }
    /** 埋点：把 agent 的会话事件尾部写进 _debug.log，用于排查 mnemon 的 turn/View 绑定。 */
    async dumpTurnState(chatKey, agent) {
        try {
            const session = agent?.session;
            const events = session?.snapshotEvents?.() ?? [];
            const tail = events.slice(-8).map(event => event.type + (typeof event.data?.turn === 'number' ? '(' + event.data.turn + ')' : ''));
            let open;
            for (const event of events) {
                if (event.type === 'turn/start' && typeof event.data?.turn === 'number')
                    open = event.data.turn;
                else if (event.type === 'turn/end' && event.data?.turn === open)
                    open = undefined;
            }
            this.dumpRaw('turn-state', 'session=' + String(session?.id) + ' openTurn=' + String(open) + ' tail=' + tail.join(' | '));
        }
        catch (error) {
            this.dumpRaw('turn-state 失败', error instanceof Error ? error.message : String(error));
        }
    }
    /** 登记空间 id（供 napcat_memory_space 工具调用）。 */
    async saveSpace(chatKey, spaceId) {
        const dir = await this.ensureDir(chatKey);
        await writeFile(join(dir, SPACE_FILE), JSON.stringify({ id: spaceId }, null, 2), 'utf8');
    }
    /** 写一条长期记忆：优先 mnemon，失败落 notes.md。 */
    async remember(chatKey, content, agent, tags = []) {
        const text = content.trim();
        if (text === '')
            throw new Error('记忆内容为空');
        const id = await this.ensureSpace(chatKey, agent);
        if (id !== undefined) {
            try {
                await this.callTool('mnemon_remember', {
                    content: text,
                    category: 'fact',
                    importance: 3,
                    memoryBodyId: id,
                    tags: ['napcat', ...tags],
                    source: 'user',
                }, agent);
                return '已写入本群长期记忆（mnemon）';
            }
            catch (error) {
                this.reportFailure('mnemon 写入失败，落本地笔记', error);
            }
        }
        const dir = await this.ensureDir(chatKey);
        await appendFile(join(dir, NOTES_FILE), '- [' + new Date().toISOString() + '] ' + text.replace(/\s+/g, ' ') + '\n', 'utf8');
        return '已写入本群笔记（本地文件）';
    }
    /** 召回与本群相关的内容（query 用最近对话摘要）。 */
    async recall(chatKey, query, agent) {
        if (query.trim() === '')
            return '';
        // mnemon 的读取要求本轮 View，插件在轮次外调用必失败（会返回 Error 文本）→ 交给模型轮内显式回忆
        if (this.opts.backend === 'mnemon')
            return '';
        const id = await this.ensureSpace(chatKey, agent);
        if (id !== undefined) {
            try {
                const text = await this.callTool('mnemon_recall', { query, memoryBodyIds: [id], limit: 3 }, agent);
                if (text.trim() !== '')
                    return text.trim();
            }
            catch (error) {
                this.opts.log('debug', 'mnemon 召回失败: ' + (error instanceof Error ? error.message : String(error)));
            }
        }
        // 落本地笔记兜底：取最近 20 行里与 query 关键词有交集的
        try {
            const notes = await readFile(join(this.dirFor(chatKey), NOTES_FILE), 'utf8');
            const lines = notes.split('\n').filter(line => line.startsWith('- '));
            const matched = lines.filter(line => query.split(/\s+/).some(word => word.length > 1 && line.includes(word)));
            return matched.slice(-3).join('\n');
        }
        catch {
            return '';
        }
    }
    /** 追加一条最近消息（滚动保留）。 */
    async appendRecent(chatKey, entry) {
        try {
            const dir = await this.ensureDir(chatKey);
            const path = join(dir, RECENT_FILE);
            const line = JSON.stringify({ t: entry.at ?? Date.now(), nick: entry.nick.slice(0, 24), text: entry.text.slice(0, 500) });
            await appendFile(path, line + '\n', 'utf8');
            // 简单滚动：超过 3 倍上限时压回上限条数
            const content = await readFile(path, 'utf8');
            const lines = content.split('\n').filter(part => part.trim() !== '');
            if (lines.length > this.opts.recentLimit * 3) {
                await writeFile(path, lines.slice(-this.opts.recentLimit).join('\n') + '\n', 'utf8');
            }
        }
        catch (error) {
            this.opts.log('debug', '记录群消息失败: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    /**
     * 预热：把历史消息**合并**进 recent（按 时间+内容 去重；旧记录里昵称为空而新数据有昵称时自动补全）。
     * 注意：绝不能覆盖——否则每次"缓冲过期"都会把之前攒的几十上百条历史顶掉。
     */
    async seedRecent(chatKey, entries) {
        if (entries.length === 0)
            return 0;
        const dir = await this.ensureDir(chatKey);
        const path = join(dir, RECENT_FILE);
        // 归一化：把 [图片:<文件名>] 视作 [图片]，否则同一张图会被"实时带文件名 / 历史只有占位符"记成两条
        const normText = (text) => text.replace(/\[图片:[^\]]*\]/g, '[图片]').trim();
        // 时间容差：历史接口是秒级、实时是毫秒级，同一条消息可能差 1~3 秒 → 用 5 秒窗口判重
        const timeKey = (t) => Math.floor(t / 5000);
        const bucketOf = (row) => timeKey(row.t) + '|' + normText(row.text);
        /** 两条记录里挑更完整的：有昵称优先，其次文本更长（带缓存文件名）。 */
        const better = (left, right) => {
            const leftRich = left.nick !== '' && left.nick !== '?';
            const rightRich = right.nick !== '' && right.nick !== '?';
            if (leftRich !== rightRich)
                return rightRich ? right : left;
            return right.text.length > left.text.length ? right : left;
        };
        const merged = new Map();
        // 先放已有记录
        try {
            const existing = await readFile(path, 'utf8');
            for (const line of existing.split('\n')) {
                if (line.trim() === '')
                    continue;
                try {
                    const row = JSON.parse(line);
                    if (typeof row.t === 'number') {
                        const key = bucketOf(row);
                        const previous = merged.get(key);
                        merged.set(key, previous === undefined ? row : better(previous, row));
                    }
                }
                catch {
                    // 坏行跳过
                }
            }
        }
        catch {
            // 文件还不存在
        }
        const before = merged.size;
        for (const entry of entries) {
            const row = {
                t: entry.at ?? Date.now(),
                nick: entry.nick.slice(0, 24),
                text: entry.text.slice(0, 500),
            };
            const key = bucketOf(row);
            const previous = merged.get(key);
            if (previous !== undefined) {
                merged.set(key, better(previous, row));
            }
            else {
                // 桶边界兜底：前后各 1 秒内已有同内容也算同一条
                let matched = false;
                for (const [existingKey, existingRow] of merged) {
                    if (normText(existingRow.text) === normText(row.text) && Math.abs(existingRow.t - row.t) <= 3000) {
                        merged.set(existingKey, better(existingRow, row));
                        matched = true;
                        break;
                    }
                }
                if (!matched)
                    merged.set(key, row);
            }
        }
        const rows = [...merged.values()].sort((left, right) => left.t - right.t).slice(-this.opts.recentLimit);
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
        return Math.max(0, merged.size - before);
    }
    /** 缓冲里最新一条的时间戳（毫秒；空=0）。用于判断缓冲是否"过期"。 */
    async recentNewestAt(chatKey) {
        try {
            const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8');
            const lines = content.split('\n').filter(part => part.trim() !== '');
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                try {
                    const parsed = JSON.parse(lines[index]);
                    if (typeof parsed.t === 'number')
                        return parsed.t;
                }
                catch {
                    // 坏行跳过
                }
            }
            return 0;
        }
        catch {
            return 0;
        }
    }
    /** 当前缓冲条数（用于判断是否需要预热）。 */
    async recentCount(chatKey) {
        try {
            const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8');
            return content.split('\n').filter(part => part.trim() !== '').length;
        }
        catch {
            return 0;
        }
    }
    /** 读最近 N 条，返回「昵称: 内容」行。 */
    async readRecent(chatKey, limit) {
        try {
            const content = await readFile(join(this.dirFor(chatKey), RECENT_FILE), 'utf8');
            const lines = content.split('\n').filter(part => part.trim() !== '').slice(-(limit ?? this.opts.injectRecent));
            const result = [];
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    const clock = parsed.t === undefined ? '' : new Date(parsed.t).toTimeString().slice(0, 5) + ' ';
                    result.push(clock + (parsed.nick ?? '?') + ': ' + (parsed.text ?? ''));
                }
                catch {
                    // 坏行跳过
                }
            }
            return result;
        }
        catch {
            return [];
        }
    }
    /** 组装注入文本（含 @ 优先级指令），超预算截断。 */
    buildInjection(parts) {
        const blocks = [];
        blocks.push('这个会话来自 QQ（NapCat 渠道），聊天对象是 ' + parts.chatKey + '。');
        if (parts.mention !== undefined && parts.mention !== '') {
            blocks.push('【当前 @你 的人（优先级最高，先回答他的问题）】' + parts.mention);
        }
        if (parts.recent.length > 0) {
            blocks.push('【最近群聊（背景，用于理解话题，不要逐条回应）】\n' + parts.recent.join('\n'));
        }
        if (this.opts.backend === 'mnemon') {
            if (parts.spaceId !== undefined && parts.spaceId !== '') {
                blocks.push('【本群长期记忆（mnemon）】空间 id = ' + parts.spaceId + '\n' +
                    '写入：mnemon_remember({ memoryBodyId: "' + parts.spaceId + '", content: "…", tags: ["napcat","' + parts.chatKey + '"] })\n' +
                    '回忆：必须显式调用 mnemon_recall({ memoryBodyIds: ["' + parts.spaceId + '"], query: "…" }) —— 不要依赖 mnemon 的自动回忆。\n' +
                    '分层约定（写入时 content 加前缀 + tags 区分）：\n' +
                    '  【设定】群规矩 / 称呼 / 习惯 → tags 加 "setting"\n' +
                    '  【黑话】群内术语 / 缩写 → tags 加 "glossary"\n' +
                    '  【人物】成员关系 / 身份 / 别名 → tags 加 "person"\n' +
                    '  【事实】其他结论 / 约定 → 不加额外标签\n' +
                    '回答本群问题前先做固定层召回：mnemon_recall({ memoryBodyIds: ["' + parts.spaceId + '"], query: "设定 称呼 黑话 人物" })，' +
                    '再按当前话题做一次按需召回。\n' +
                    (this.opts.autoCapture === false ? '' : '【自动记忆】不需要用户说「记住」：只要本轮对话里出现了下面任一**新信息**，你就自己调用 mnemon_remember 写入（不必告知用户，也不必询问）：\n' +
                        '  · 群规矩 / 称呼习惯 / 禁忌 → content 前缀【设定】, tags 加 "setting"\n' +
                        '  · 群内术语 / 缩写 / 梗 → 前缀【黑话】, tags 加 "glossary"\n' +
                        '  · 成员身份 / 关系 / 别名 → 前缀【人物】, tags 加 "person"\n' +
                        '  · 明确的结论 / 约定 / 待办 → 前缀【事实】\n' +
                        '写入规则：①先做一次固定层召回，已存在的不重复写；②每条尽量 ≤ 60 字，写清楚「谁/什么/怎么叫」；③一次最多写 2 条，不确定就不写；④不要把闲聊、玩笑、临时情绪写进去。\n' +
                        '【更新规则】记忆不是只增不改，信息变化时必须改：\n' +
                        '  ① 先固定层召回，按「同一主体」找旧条目（同一个人的称呼 / 同一条规矩 / 同一个黑话）；\n' +
                        '  ② 若旧条目已被**修正/替换**（改名、换人、规则变更、含义变化）→ 先 mnemon_forget({ id: <旧条目 id> }) 软删，再 mnemon_remember 写入新版本；\n' +
                        '  ③ 新版本 content 末尾加（更新于 MM-DD），例如【人物】张哥=老张（更新于 10-23）；\n' +
                        '  ④ 若只是**补充细节**（旧内容仍正确）→ 直接写一条带【补充】的新条目，不要删旧的；\n' +
                        '  ⑤ 用户说「忘掉 X」或明确指出某条已不成立 → 召回后 mnemon_forget 掉对应条目，并简短确认。\n' +
                        '【静默规则】记忆的增/改/删**全部静默执行**，不要向用户汇报过程：\n' +
                        '  · 不要提「软删除 / 空间 / 条目 / mnemon / 向量 / 召回」等内部词；\n' +
                        '  · 不要罗列你做了什么操作（"我会删掉旧的再写新的"这种一律不要说）；\n' +
                        '  · 只有用户明确问「你记得什么 / 记住没」时，才用一两句说出**内容本身**；\n' +
                        '  · 用户让你记住时，确认语尽量短（≤ 15 字，口语化），例如「好，以后叫帅哥」；\n' +
                        '  · 群聊里保持自然聊天语气，不要像系统日志。'));
            }
            else {
                blocks.push('【本群长期记忆（mnemon）尚未配置空间 id】\n' +
                    '本群还没有记忆空间。需要长期记住信息前：先 mnemon_memory_body_create({ name: "' + this.opts.spacePrefix + parts.chatKey + '", description: "QQ ' + parts.chatKey + ' 的长期记忆" })，' +
                    '再 mnemon_memory_body_update({ memoryBodyId: <id>, active: true })，然后调用 napcat_memory_space({ group_id: "' + parts.chatKey.split(':')[1] + '", space_id: <id> }) 让插件记住这个 id。');
            }
        }
        if (parts.recallText !== undefined && parts.recallText !== '') {
            blocks.push('【本群长期记忆（相关片段）】\n' + parts.recallText);
        }
        let text = blocks.join('\n\n');
        if (text.length > this.opts.injectMaxChars) {
            text = text.slice(0, this.opts.injectMaxChars) + '\n…（记忆超预算已截断，需要时请把要点压缩）';
        }
        return text;
    }
}
