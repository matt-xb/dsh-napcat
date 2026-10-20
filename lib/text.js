/** 消息段 → 纯文本、@ 判定、长文分段。 */
const PLACEHOLDER = {
    image: '[图片]',
    record: '[语音]',
    video: '[视频]',
    file: '[文件]',
    face: '[表情]',
    mface: '[表情]',
    reply: '',
    forward: '[合并转发]',
    json: '[卡片]',
    xml: '[卡片]',
    poke: '[戳一戳]',
    dice: '[骰子]',
    rps: '[猜拳]',
    music: '[音乐]',
    location: '[位置]',
    contact: '[名片]',
    markdown: '[卡片]',
};
/** 解析 CQ 码字符串（NapCat 配成字符串上报时的兜底；数组更常见）。 */
export function parseCq(raw) {
    const out = [];
    const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;
    let last = 0;
    for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
        if (m.index > last)
            out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last, m.index)) } });
        const data = {};
        const params = m[2] ?? '';
        for (const pair of params.split(',').slice(1)) {
            const eq = pair.indexOf('=');
            if (eq > 0)
                data[pair.slice(0, eq)] = unescapeCq(pair.slice(eq + 1));
        }
        out.push({ type: m[1] ?? 'text', data });
        last = m.index + m[0].length;
    }
    if (last < raw.length)
        out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last)) } });
    return out;
}
function unescapeCq(value) {
    return value
        .replace(/&#44;/g, ',')
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&amp;/g, '&');
}
/** 归一化成消息段数组。 */
export function segmentsOf(message) {
    if (message === undefined || message === null)
        return [];
    if (Array.isArray(message))
        return message;
    return parseCq(String(message));
}
/** 把消息段拼成给模型看的纯文本（图片/语音等转成占位符）。 */
export function toText(message, selfId = '', selfName = '你') {
    const parts = [];
    for (const seg of segmentsOf(message)) {
        const data = seg.data ?? {};
        if (seg.type === 'text') {
            parts.push(String(data.text ?? ''));
            continue;
        }
        if (seg.type === 'at') {
            const qq = String(data.qq ?? '');
            if (qq === 'all')
                parts.push('@全体成员');
            else if (selfId !== '' && qq === selfId)
                parts.push('@' + selfName);
            else
                parts.push('@' + String(data.name ?? qq));
            continue;
        }
        const holder = PLACEHOLDER[seg.type];
        if (holder !== undefined)
            parts.push(holder);
        else if (seg.type !== 'text')
            parts.push('[' + seg.type + ']');
    }
    return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
}
/** 是否 @ 了指定 QQ（群聊门控用）。 */
export function mentions(message, selfId) {
    if (selfId === '')
        return false;
    return segmentsOf(message).some(seg => seg.type === 'at' && String(seg.data?.qq ?? '') === selfId);
}
/** 是否引用了指定消息（回复机器人的消息也算"提及"，由调用方决定是否启用）。 */
export function repliesTo(message, messageId) {
    if (messageId === '')
        return false;
    return segmentsOf(message).some(seg => seg.type === 'reply' && String(seg.data?.id ?? '') === messageId);
}
/**
 * 长文分段：优先按空行切，其次按句号/换行，最后硬切。
 * 返回的每段都不超过 maxChars（maxChars <= 0 时原样返回一段）。
 */
export function splitText(text, maxChars) {
    const trimmed = text.trim();
    if (trimmed === '' || maxChars <= 0 || trimmed.length <= maxChars)
        return trimmed === '' ? [] : [trimmed];
    const chunks = [];
    let rest = trimmed;
    while (rest.length > maxChars) {
        const window = rest.slice(0, maxChars);
        let cut = -1;
        for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', ' ']) {
            const at = window.lastIndexOf(sep);
            if (at > maxChars * 0.4) {
                cut = at + sep.length;
                break;
            }
        }
        if (cut <= 0)
            cut = maxChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trimStart();
    }
    if (rest !== '')
        chunks.push(rest);
    return chunks.filter(chunk => chunk !== '');
}
