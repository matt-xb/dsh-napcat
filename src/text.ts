/** 消息段 → 纯文本、@ 判定、长文分段。 */

import type { ObMessage, ObSegment } from './types.js'

const PLACEHOLDER: Record<string, string> = {
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
}

/** 解析 CQ 码字符串（NapCat 配成字符串上报时的兜底；数组更常见）。 */
export function parseCq(raw: string): ObSegment[] {
  const out: ObSegment[] = []
  const re = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g
  let last = 0
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    if (m.index > last) out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last, m.index)) } })
    const data: Record<string, unknown> = {}
    const params = m[2] ?? ''
    for (const pair of params.split(',').slice(1)) {
      const eq = pair.indexOf('=')
      if (eq > 0) data[pair.slice(0, eq)] = unescapeCq(pair.slice(eq + 1))
    }
    out.push({ type: m[1] ?? 'text', data })
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push({ type: 'text', data: { text: unescapeCq(raw.slice(last)) } })
  return out
}

function unescapeCq(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
}

/** 归一化成消息段数组。 */
export function segmentsOf(message: ObMessage | undefined): ObSegment[] {
  if (message === undefined || message === null) return []
  if (Array.isArray(message)) return message
  return parseCq(String(message))
}

/** 把消息段拼成给模型看的纯文本（图片/语音等转成占位符）。 */
export function toText(message: ObMessage | undefined, selfId = '', selfName = '你'): string {
  const parts: string[] = []
  for (const seg of segmentsOf(message)) {
    const data = seg.data ?? {}
    if (seg.type === 'text') {
      parts.push(String(data.text ?? ''))
      continue
    }
    if (seg.type === 'at') {
      const qq = String(data.qq ?? '')
      if (qq === 'all') parts.push('@全体成员')
      else if (selfId !== '' && qq === selfId) parts.push('@' + selfName)
      else parts.push('@' + String(data.name ?? qq))
      continue
    }
    const holder = PLACEHOLDER[seg.type]
    if (holder !== undefined) parts.push(holder)
    else if (seg.type !== 'text') parts.push('[' + seg.type + ']')
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim()
}

/** 是否 @ 了指定 QQ（群聊门控用）。 */
export function mentions(message: ObMessage | undefined, selfId: string): boolean {
  if (selfId === '') return false
  return segmentsOf(message).some(seg => seg.type === 'at' && String(seg.data?.qq ?? '') === selfId)
}

/** 是否引用了指定消息（回复机器人的消息也算"提及"，由调用方决定是否启用）。 */
export function repliesTo(message: ObMessage | undefined, messageId: string): boolean {
  if (messageId === '') return false
  return segmentsOf(message).some(seg => seg.type === 'reply' && String(seg.data?.id ?? '') === messageId)
}

/**
 * 长文分段：优先按空行切，其次按句号/换行，最后硬切。
 * 返回的每段都不超过 maxChars（maxChars <= 0 时原样返回一段）。
 */
export function splitText(text: string, maxChars: number): string[] {
  const trimmed = text.trim()
  if (trimmed === '' || maxChars <= 0 || trimmed.length <= maxChars) return trimmed === '' ? [] : [trimmed]

  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    for (const sep of ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', ' ']) {
      const at = window.lastIndexOf(sep)
      if (at > maxChars * 0.4) {
        cut = at + sep.length
        break
      }
    }
    if (cut <= 0) cut = maxChars
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks.filter(chunk => chunk !== '')
}
/** 在文本里找第一个命中的触发关键字（大小写不敏感，空词忽略）。 */
export function findKeyword(text: string, words: readonly string[]): string | undefined {
  if (words.length === 0) return undefined
  const lowered = text.toLowerCase()
  for (const word of words) {
    const needle = String(word ?? '').trim()
    if (needle === '') continue
    if (lowered.includes(needle.toLowerCase())) return needle
  }
  return undefined
}

/** 去掉命中的触发关键字（大小写不敏感，只去掉第一个）。 */
export function stripKeyword(text: string, keyword: string): string {
  const index = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (index < 0) return text
  return (text.slice(0, index) + text.slice(index + keyword.length)).trim()
}
/** 消息是否引用了这批消息 id 中的任意一条。 */
export function repliesToAny(message: ObMessage | undefined, ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  const wanted = new Set(ids)
  return segmentsOf(message).some(seg => seg.type === 'reply' && wanted.has(String(seg.data?.id ?? '')))
}
/** 稳定的短哈希（djb2 → base36），用于把 cwd 编进会话 id。 */
export function shortHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}
/**
 * 解析「群/人性格」配置：每行 `<group:群号|private:QQ>=<人设文本>`，
 * 支持 `#` 注释与空行。返回 key → 文本（key 形如 `group:123`）。
 */
export function parsePersonaOverrides(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const text = trimmed.slice(at + 1).trim()
    if (!/^(group|private)[:：](?:\d+|\*)$/.test(key) || text === '') continue
    map.set(key.replace('：', ':'), text)
  }
  return map
}
/** Harness 每轮注入的 runtime context 行；只认整行，正文里顺口提到同样字样不受影响。 */
const RUNTIME_CONTEXT_LINE = /^(?:Time sampled while preparing turn \d+, step \d+:|Browser time zone for this request:|Elapsed since the preceding (?:model-visible message|step context):)/
const RUNTIME_CONTEXT_HEAD = /^Time sampled while preparing turn \d+, step \d+:/
/**
 * 模型把宿主注入的时间快照复述进正文时，剥掉那几行，其余正文一字不动。
 * 只认「以 Time sampled… 打头、紧跟着还连着别的标记行」的整块；孤立一句是正常聊天，群里就拿它问"这是啥"。
 */
function stripRuntimeContext(text: string): string {
  const lines = text.split('\n')
  const isMark = (line: string | undefined): boolean => RUNTIME_CONTEXT_LINE.test((line ?? '').trim())
  const drop = lines.map(() => false)
  for (let head = 0; head < lines.length; head += 1) {
    if (!RUNTIME_CONTEXT_HEAD.test((lines[head] ?? '').trim())) continue
    const block = [head]
    let index = head + 1
    // 注入块是几行连着；复述时空行不算断。
    for (; index < lines.length && ((lines[index] ?? '').trim() === '' || isMark(lines[index])); index += 1) {
      if (isMark(lines[index])) block.push(index)
    }
    if (block.length < 2) continue
    // 块内的空行一起删，免得原处留一段空白。
    for (let at = block[0] ?? head; at <= (block[block.length - 1] ?? head); at += 1) drop[at] = true
    head = index - 1
  }
  if (!drop.some(Boolean)) return text
  return lines.filter((_, index) => drop[index] !== true).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
}
/** Internal context must never be forwarded to QQ. */
export function sanitizeReply(text: string): string | null {
  const clean = text.replaceAll('[[NAPCAT_SILENT]]', '').replace(/<\/?ap>/g, '')
  if (/这个会话来自QQ（NapCat渠道），聊天对象是|【本聊天(?:历史与明确事实|最近记录)[（】]|【当前群消息上下文[（】]|<system-reminder>|\[modelchanged:/i.test(clean.replace(/\s+/g, ''))) return null
  return stripRuntimeContext(clean)
}

/** Compact short Chinese prose only; preserve structured and long-form output. */
// shortcut: structure heuristics cannot distinguish prose-like verse; add explicit layout metadata if exact verse formatting is required.
export function compactShortReply(text: string): string {
  if (text.length > 120 || !/\p{Script=Han}/u.test(text) ||
    /[`\[\]{}<>|\\$]|https?:\/\/|(?:^|[\r\n])[ \t]*(?:[A-Za-z_]|[-*+•>#]|(?:\d+|[一二三四五六七八九十]+)[.、)）])/.test(text)) return text
  return text.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).join(' ')
}

/** Same-turn comparison only; preserve numbers, code and emotional punctuation. */
export function replyDedupKey(text: string): string {
  return text.length <= 120 && /^[\p{Script=Han}\s，。,．.]+$/u.test(text) && /\p{Script=Han}/u.test(text)
    ? text.replace(/[\s，。,．.]/g, '') : text
}

/** Tool and automatic sends share this wire boundary. */
export function sanitizeOutgoingMessage(message: unknown): ObMessage {
  const clean = (text: string): string => {
    const result = sanitizeReply(text)
    if (result === null) throw new Error('拒绝外发内部上下文或模型通知')
    return result
  }
  if (typeof message === 'string') {
    const result = clean(message)
    if (!result.trim()) throw new Error('空消息不外发')
    return result
  }
  if (!Array.isArray(message) || !message.every((seg: unknown) => seg !== null && typeof seg === 'object' && typeof (seg as ObSegment).type === 'string')) throw new Error('发送消息必须是字符串或消息段数组')
  const segments = message as ObSegment[]
  clean(segments.filter(seg => seg.type === 'text').map(seg => String(seg.data?.text ?? '')).join(''))
  const result = segments.map(seg => seg.type === 'text'
    ? { ...seg, data: { ...seg.data, text: clean(String(seg.data?.text ?? '')) } } : seg)
  if (!result.some(seg => seg.type !== 'reply' && (seg.type !== 'text' || String(seg.data?.text ?? '').trim()))) throw new Error('空消息不外发')
  return result.filter(seg => seg.type !== 'text' || seg.data?.text !== '')
}

/** 会话标题：`MM-DD HH:mm`（本地时间；内容容易乱，所以只标时间）。 */
export function titleFrom(text: string, now: Date = new Date()): string {
  void text
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = pad(now.getMonth() + 1) + '-' + pad(now.getDate())
  const time = pad(now.getHours()) + ':' + pad(now.getMinutes())
  return date + ' ' + time
}
/** 文件名模糊匹配打分（0 = 不匹配）。用户常只记得一部分名字。 */
export function scoreFileName(name: string, query: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s_\-—–]+/g, '')
  const a = norm(name)
  const q = norm(query)
  if (q === '') return 0
  if (a === q) return 100
  const stem = a.replace(/\.[a-z0-9]{1,8}$/, '')
  const qStem = q.replace(/\.[a-z0-9]{1,8}$/, '')
  if (stem === qStem) return 90
  if (a.startsWith(q) || stem.startsWith(qStem)) return 80
  if (a.includes(q) || stem.includes(qStem)) return 60
  const tokens = query.toLowerCase().split(/[\s_\-—–]+/).filter(part => part !== '')
  if (tokens.length > 1 && tokens.every(part => a.includes(norm(part)))) return 40
  return 0
}

/** 按模糊打分排序候选（只返回 score>0）。 */
export function rankByFileName<T>(items: readonly T[], query: string, nameOf: (item: T) => string): Array<{ item: T; score: number }> {
  return items
    .map(item => ({ item, score: scoreFileName(nameOf(item), query) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
}