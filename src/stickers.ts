import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const SYNONYMS = [
  ['困惑', '看不懂', '没看懂', '问号', '疑惑', '什么鬼', '啥意思'],
  ['累了', '休息', '摸鱼', '瘫', '疲惫', '困了', '好困', '困死', '想睡', '躺平', '摆烂'],
  ['下班', '收工', '开溜', '走了', '撤'],
  ['开心', '得意', '高兴', '美滋滋', '欢呼', '快乐', '好耶', '爽'],
  ['惊讶', '震惊', '离谱', '意外', '吓一跳', '卧槽', '我去'],
  ['馋', '饿', '干饭', '食物', '想吃', '好吃'],
  ['赞同', '收到', 'ok', '答应', '同意', '好的', '行', '没问题', '点头'],
  ['自信', '耍帅', '轻度中二', '中二', '牛', '厉害'],
  ['你好', '问好', '打招呼', '报到', '在吗', '早上好', '晚安'],
  ['哈哈', '好笑', '大笑', '笑死', '笑', '乐'],
  ['喜欢', '爱你', '好感', '心动', '比心', '喜欢你了'],
  ['害羞', '脸红', '不好意思', '羞'],
  ['生气', '烦', '恼火', '气死', '不爽', '骂'],
  ['无语', '沉默', '汗', '尴尬', '翻白眼', '看不下去'],
  ['难过', '伤心', '委屈', '哭', '想哭', '失落'],
  ['撒娇', '贴贴', '抱', '亲昵', '要表扬'],
  ['谢谢', '感谢', '多谢', '谢了'],
  ['加油', '鼓励', '努力', '撑住', '冲'],
  ['再见', '拜拜', '晚安', '去睡'],
  ['上班', '加班', '打工', '工作', '干活'],
  ['无聊', '没劲', '发呆', '闲'],
  ['吃瓜', '看戏', '围观', '凑热闹'],
  ['失败', '翻车', '完蛋', '崩了'],
]
export interface StickerMatch {
  id: string
  path: string
  recentlyUsed: boolean
  tags: string[]
  title: string
  description: string
  useWhen: string
  avoid: string
  score: number
}
const imageKey = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const normalize = (value: string): string => value.normalize('NFKC').toLowerCase()
function words(value: string): Set<string> {
  const text = normalize(value)
  const result = new Set(text.match(/[a-z0-9]+/g) ?? [])
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) result.add(run)
    for (let i = 0; i < run.length - 1; i++) result.add(run.slice(i, i + 2))
  }
  return result
}
function score(title: string, tags: string[], queryWords: Set<string>, query: string): number {
  const text = normalize([title, ...tags].join(' '))
  const tokens = words(text)
  let value = [...queryWords].filter(word => tokens.has(word)).length
  for (const group of SYNONYMS) {
    if (group.some(word => word.length === 1 ? queryWords.has(word) : query.includes(word))
      && group.some(word => word.length === 1 ? tokens.has(word) : text.includes(word))) value += 3
  }
  return value
}

/** Only the current chat selects a scope; query never selects paths or catalogs. */
export async function findStickers(chatKey: string, query: string, root = '', recentImages: readonly string[] = []): Promise<StickerMatch[]> {
  const scope = /^(private|group):([0-9]+)$/.exec(chatKey)
  if (!scope || !root.trim() || !query.trim()) return []
  const queryWords = words(query)
  if (!queryWords.size) return []
  let base: string
  try { base = await realpath(root) } catch { return [] }
  const directories = [base, join(base, 'from-' + scope[1] + '-' + scope[2])]
  const used = new Map(recentImages.filter(isAbsolute).map((value, index) => [imageKey(value), index]))
  const matches: StickerMatch[] = []
  for (const directory of directories) {
    try {
      const actualDir = await realpath(directory)
      if (actualDir !== base && dirname(actualDir) !== base) continue
      if (actualDir !== directory) continue
      const catalogPath = join(directory, 'catalog.json')
      if (await realpath(catalogPath) !== catalogPath) continue
      const catalog: unknown = JSON.parse(await readFile(catalogPath, 'utf8'))
      if (!Array.isArray(catalog)) continue
      for (const raw of catalog) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as Record<string, unknown>
        if (directory !== base ? entry.status !== 'active' || entry.allowedChat !== chatKey
          : (entry.status !== undefined && entry.status !== 'active') || (entry.allowedChat !== undefined && entry.allowedChat !== chatKey)) continue
        const title = typeof entry.title === 'string' ? entry.title : ''
        const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag: unknown): tag is string => typeof tag === 'string') : typeof entry.tags === 'string' ? [entry.tags] : []
        const rank = score(title, tags, queryWords, normalize(query))
        if (!rank || typeof entry.id !== 'string' || typeof entry.path !== 'string'
          || !isAbsolute(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) continue
        const path = resolve(entry.path)
        if (dirname(path) !== directory || path === catalogPath) continue
        try {
          if (await realpath(path) !== path) continue
          const bytes = await readFile(path)
          if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256.toLowerCase()) continue
        } catch { continue }
        matches.push({ id: entry.id, path, recentlyUsed: used.has(imageKey(path)), tags, title,
          description: typeof entry.description === 'string' ? entry.description : '',
          useWhen: typeof entry.useWhen === 'string' ? entry.useWhen : '',
          avoid: typeof entry.avoid === 'string' ? entry.avoid : '', score: rank })
      }
    } catch { /* Missing or redirected catalogs fail closed. */ }
  }
  // Rotate within two-point score bands, including after every comparable image was used.
  const best = Math.max(0, ...matches.map(match => match.score))
  const tier = (match: StickerMatch): number => Math.floor((best - match.score) / 2)
  return matches.sort((a, b) => tier(a) - tier(b)
    || Number(a.recentlyUsed) - Number(b.recentlyUsed)
    || (used.get(imageKey(a.path)) ?? -1) - (used.get(imageKey(b.path)) ?? -1)
    || b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5)
}
