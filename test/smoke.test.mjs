// 纯逻辑冒烟测试（不依赖宿主包，直接测编译产物 lib/）。
// 运行：npm run build && node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'

import { base64UrlToBuffer, isHttpUrl, nameFromRef, safeName } from '../lib/media.js'
import { MemoryStore } from '../lib/memory.js'
import { decide, inQuietHours, newChatState, parseQuietHours, poissonHit, skipBackoffFactor } from '../lib/proactive.js'
import { findKeyword, mentions, parseCq, parsePersonaOverrides, rankByFileName, scoreFileName, shortHash, splitText, stripKeyword, titleFrom, toText } from '../lib/text.js'
import { allowAccess, chatRefOf, sessionIdForChat } from '../lib/chat.js'

const config = {
  adminUsers: ['10001'],
  dmPolicy: 'admin',
  allowFrom: [],
  groupPolicy: 'allowlist',
  groupAllowFrom: ['20002'],
}

test('splitText 按上限分段且不超长', () => {
  const text = ('第一句话。'.repeat(400)).trim()
  const chunks = splitText(text, 1200)
  assert.ok(chunks.length >= 2)
  for (const chunk of chunks) assert.ok(chunk.length <= 1200, 'segment too long: ' + chunk.length)
  assert.ok(text.includes(chunks[0]), '首段应是原文的前缀片段')
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})

test('splitText 短文本原样返回', () => {
  assert.deepEqual(splitText('  hi  ', 1200), ['hi'])
  assert.deepEqual(splitText('   ', 1200), [])
})

test('toText 处理文本 / @ / 图片占位', () => {
  const message = [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 你好' } },
    { type: 'image', data: { file: 'a.jpg' } },
  ]
  assert.equal(toText(message, '99999'), '@10001 你好[图片]')
  assert.equal(toText(message, '10001'), '@你 你好[图片]')
  assert.equal(toText([{ type: 'at', data: { qq: 'all' } }], ''), '@全体成员')
})

test('mentions 只认指定 QQ', () => {
  const at = [{ type: 'at', data: { qq: '10001' } }]
  assert.equal(mentions(at, '10001'), true)
  assert.equal(mentions(at, '99999'), false)
  assert.equal(mentions(at, ''), false)
})

test('parseCq 解析兜底的 CQ 字符串', () => {
  const segments = parseCq('[CQ:image,file=a.jpg,url=https://x/y]hi&#91;1&#93;')
  assert.equal(segments.length, 2)
  assert.equal(segments[0]?.type, 'image')
  assert.equal(segments[0]?.data?.file, 'a.jpg')
  assert.equal(segments[1]?.type, 'text')
  assert.equal(segments[1]?.data?.text, 'hi[1]')
})

test('chatRefOf 区分私聊与群聊', () => {
  assert.deepEqual(chatRefOf({ post_type: 'message', message_type: 'private', user_id: 123, message: [] }),
    { kind: 'private', id: '123', key: 'private:123' })
  assert.deepEqual(chatRefOf({ post_type: 'message', message_type: 'group', group_id: 789, user_id: 1, message: [] }),
    { kind: 'group', id: '789', key: 'group:789' })
})

test('准入策略：私聊仅管理员、群聊白名单', () => {
  assert.equal(allowAccess(config, { kind: 'private', id: '10001', key: 'private:10001' }, '10001'), true)
  assert.equal(allowAccess(config, { kind: 'private', id: '10002', key: 'private:10002' }, '10002'), false)
  assert.equal(allowAccess(config, { kind: 'group', id: '20002', key: 'group:20002' }, '1'), true)
  assert.equal(allowAccess(config, { kind: 'group', id: '20003', key: 'group:20003' }, '1'), false)
})

test('session id 稳定且合法', () => {
  assert.equal(sessionIdForChat('private:123'), 'napcat-private-123')
  assert.equal(sessionIdForChat('group:789'), 'napcat-group-789')
  assert.match(sessionIdForChat('group:a b/c'), /^[A-Za-z0-9_-]+$/)
})
test('findKeyword 命中/大小写/空表', () => {
  assert.equal(findKeyword('你好 小助手 在吗', ['小助手']), '小助手')
  assert.equal(findKeyword('HELLO Bot', ['bot']), 'bot')
  assert.equal(findKeyword('随便说说', ['小助手']), undefined)
  assert.equal(findKeyword('任何内容', []), undefined)
  assert.equal(findKeyword('空词表里有空白', ['   ']), undefined)
})

test('stripKeyword 去掉第一个命中且 trim', () => {
  assert.equal(stripKeyword('小助手 帮我查天气', '小助手'), '帮我查天气')
  assert.equal(stripKeyword('帮我查天气 小助手', '小助手'), '帮我查天气')
  assert.equal(stripKeyword('没有关键字', '小助手'), '没有关键字')
})
test('shortHash 稳定且区分不同路径', () => {
  const a = shortHash('E:\\dsnworkspace\\napcat\\group-1')
  const b = shortHash('E:\\dsnworkspace\\napcat\\group-1')
  const c = shortHash('C:\\Windows\\System32')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-z]{1,7}$/)
})
test('parsePersonaOverrides 解析群/人性格', () => {
  const map = parsePersonaOverrides([
    '# 注释行',
    'group:123456=你是群宠小灯，语气活泼',
    'private:10001 = 私人助理，正式一点',
    '',
    '  乱写一行没有等号',
    'group:999=',
  ].join('\n'))
  assert.equal(map.get('group:123456'), '你是群宠小灯，语气活泼')
  assert.equal(map.get('private:10001'), '私人助理，正式一点')
  assert.equal(map.has('group:999'), false)   // 空文本丢弃
  assert.equal(map.size, 2)
})

test('parsePersonaOverrides 空输入返回空表', () => {
  assert.equal(parsePersonaOverrides('').size, 0)
  assert.equal(parsePersonaOverrides('group:1=x\nprivate:2=y').size, 2)
})
test('titleFrom 生成 MM-DD HH:mm', () => {
  const at = new Date(2026, 9, 22, 9, 5)
  assert.equal(titleFrom('小灯讲个笑话', at), '10-22 09:05')
  assert.equal(titleFrom('', new Date(2026, 0, 3, 23, 59)), '01-03 23:59')
})
test('media 小工具', () => {
  assert.equal(isHttpUrl('https://a/b.png'), true)
  assert.equal(isHttpUrl('C:\\a\\b.png'), false)
  assert.equal(safeName('../../etc/passwd', 'x'), 'passwd')
  assert.equal(safeName('a/b:c*d.png', 'x'), 'b_c_d.png')
  assert.equal(nameFromRef('file:///data/1234.jpg', 'i.png'), '1234.jpg')
  assert.equal(base64UrlToBuffer('base64://aGk=').toString('utf8'), 'hi')
})
test('文件名模糊匹配', () => {
  assert.equal(scoreFileName('自然，这是一部手稿.docx', '手稿'), 60)
  assert.equal(scoreFileName('Natural Draft.DOCX', 'natural draft'), 90)
  assert.equal(scoreFileName('abc.pdf', 'zzz'), 0)
  const ranked = rankByFileName(
    [{ n: '自然，这是一部手稿.docx' }, { n: '无关.pdf' }],
    '手稿',
    (entry) => entry.n,
  )
  assert.equal(ranked.length, 1)
})
test('记忆注入：@ 优先 + 预算截断', () => {
  const store = new MemoryStore({
    ctx: {},
    root: 'unused',
    spacePrefix: 'napcat-',
    recentLimit: 10,
    injectRecent: 3,
    injectMaxChars: 200,
    log: () => undefined,
  })
  const text = store.buildInjection({
    chatKey: 'group:1',
    recent: ['12:00 张三: 在聊啥', '12:01 李四: 聊部署'],
    recallText: '本群规矩：周五发周报',
    mention: '王五：小灯你看下这个',
  })
  assert.match(text, /当前 @你 的人/)
  assert.match(text, /王五/)
  assert.match(text, /周五发周报/)
  const long = store.buildInjection({
    chatKey: 'group:1',
    recent: Array.from({ length: 50 }, (_, i) => '12:0' + i + ' 张三: ' + 'x'.repeat(20)),
    recallText: '',
    mention: '',
  })
  assert.ok(long.length <= 260)
  assert.match(long, /记忆超预算/)
})
test('主动发言：静默时段 / 泊松 / 退避 / 门槛', () => {
  const quiet = parseQuietHours('23:00-07:00,12:00-13:00')
  assert.equal(inQuietHours(3 * 60, quiet), true)     // 03:00 在跨天静默段内
  assert.equal(inQuietHours(12 * 60 + 30, quiet), true)
  assert.equal(inQuietHours(15 * 60, quiet), false)

  assert.ok(Math.abs(poissonHit(2, 30 * 60_000) - 0.632) < 0.01)
  assert.ok(poissonHit(0, 1000) === 0)
  assert.equal(skipBackoffFactor(0), 1)
  assert.equal(skipBackoffFactor(1), 0.5)

  const base = {
    enabled: true, ratePerHour: 0, chance: 1, cooldownMinutes: 30,
    maxPerHour: 3, quietHours: '', minMessages: 3, windowMinutes: 5,
  }
  const now = Date.UTC(2026, 9, 23, 4, 0, 0)
  const ok = decide({ now, minuteOfDay: 600, options: base, state: newChatState(), recentOthers: 5, random: () => 0 })
  assert.equal(ok.send, true)

  const quietMiss = decide({ now, minuteOfDay: 180, options: { ...base, quietHours: '00:00-08:00' }, state: newChatState(), recentOthers: 5, random: () => 0 })
  assert.equal(quietMiss.send, false)
  assert.equal(quietMiss.reason, 'quiet-hours')

  const few = decide({ now, minuteOfDay: 600, options: base, state: newChatState(), recentOthers: 1, random: () => 0 })
  assert.equal(few.reason, 'not-enough-chatter')

  const cooling = decide({ now, minuteOfDay: 600, options: base, state: { ...newChatState(), lastSpokeAt: now - 10_000 }, recentOthers: 5, random: () => 0 })
  assert.equal(cooling.reason, 'cooldown')
})