import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/memory.js'
import { parsePersonaOverrides, replyDedupKey, sanitizeOutgoingMessage, sanitizeReply } from '../lib/text.js'

test('personas retain exact and wildcard keys without admitting malformed scope keys', () => {
  const parsed = parsePersonaOverrides('group:*=group\nprivate：*=private\nprivate:42=exact\nprivate:../escape=bad\ngroup:*=last\nprivate:43=')
  assert.deepEqual([...parsed], [['group:*', 'last'], ['private:*', 'private'], ['private:42', 'exact']])
})

test('short Chinese punctuation dedup preserves questions, numbers and code', () => {
  assert.equal(replyDedupKey('你好，世界。'), replyDedupKey('你好世界'))
  for (const text of ['?', '？', '你好？', '你好！', '1.2', 'foo.bar', '中文'.repeat(80)]) assert.equal(replyDedupKey(text), text)
  assert.equal(sanitizeReply('[[NAPCAT_SILENT]]'), '')
  assert.equal(sanitizeReply('？'), '？')
  assert.equal(sanitizeReply('<system-reminder>secret'), null)
  // Leaked tool-call syntax must be dropped, keeping any real text on the same message.
  assert.equal(sanitizeReply('</｜｜DSML｜｜ parameter>\n> nope'), '')
  assert.equal(sanitizeReply('好啊\n</｜｜DSML｜｜ parameter>\n> nope'), '好啊')
  assert.equal(sanitizeReply('第一行\n第二行'), '第一行\n第二行')
  // Stray HTML line-break tags must never reach QQ as literal text.
  assert.equal(sanitizeReply('就回了一句\n\n<br>\n\n没图可发'), '就回了一句\n没图可发')
  assert.equal(sanitizeReply('第一句<br>第二句'), '第一句\n第二句')
  assert.equal(sanitizeReply('<br>'), '')
  assert.throws(() => sanitizeOutgoingMessage('[[NAPCAT_SILENT]]'), /空消息/)
  assert.throws(() => sanitizeOutgoingMessage([{ type: 'text', data: { text: '<system-' } }, { type: 'text', data: { text: 'reminder>secret' } }]), /内部上下文/)
  assert.deepEqual(sanitizeOutgoingMessage([{ type: 'text', data: { text: '？' } }]), [{ type: 'text', data: { text: '？' } }])
})

test('runtime time-context quoted by the model is stripped, real prose untouched', () => {
  const injected = 'Time sampled while preparing turn 78, step 1: 2026-10-25T14:52:55+08:00[Asia/Singapore]\n'
    + 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n'
    + 'Elapsed since the preceding model-visible message: 10m 0s.'
  // 夹在中间：只掉这几行，前后正文一字不动。
  assert.equal(sanitizeReply('正常就是啥也没有，只能图个稳\n\n' + injected), '正常就是啥也没有，只能图个稳')
  assert.equal(sanitizeReply(injected + '\n后面这句要留着'), '后面这句要留着')
  assert.equal(sanitizeReply('A\n' + injected.replace('10m 0s.', '10m 1s.').replace('model-visible message', 'step context') + '\nB'), 'A\nB')
  // 整段都在：清空后不发空消息。
  assert.equal(sanitizeReply(injected), '')
  assert.throws(() => sanitizeOutgoingMessage(injected), /空消息/)
  // 正常内容里提到类似字样：不当注入删。
  const chat = '群友问 Browser time zone for this request: 是啥，我说那是系统提示'
  assert.equal(sanitizeReply(chat), chat)
  assert.equal(sanitizeReply('Time sampled while preparing turn 78, step 1: 这句是报错原文吗'), 'Time sampled while preparing turn 78, step 1: 这句是报错原文吗')
  assert.equal(sanitizeReply('Elapsed since the preceding model-visible message: 这是我编的句子'), 'Elapsed since the preceding model-visible message: 这是我编的句子')
})

test('wrapper tags and local media paths never reach QQ as text', () => {
  // 模型自己吐的包装标签：整行只剩标签就删，夹在正文里也删。
  assert.equal(sanitizeReply('还在改，没修完\n</output>'), '还在改，没修完')
  assert.equal(sanitizeReply('<output>好了</output>'), '好了')
  assert.equal(sanitizeReply('<!-- 思考 -->\n看图'), '看图')
  // 图片已由工具发过：markdown + 本地绝对路径不能当文字再发一遍。
  assert.equal(sanitizeReply('![](D:\\NapCat\\stickers\\bqb-shock-01.jpg)'), '')
  assert.equal(sanitizeReply('\n![](D:\\NapCat\\stickers\\bqb-smug-06.gif)'), '')
  assert.equal(sanitizeReply('[已发送图片：bqb-shock-01.jpg]'), '[已发送图片：bqb-shock-01.jpg]')
  assert.equal(sanitizeReply('D:\\NapCat\\stickers\\maid-045-shy.png'), '')
  // 代码块和行内反引号里的标签/路径是内容，原样保留。
  assert.equal(sanitizeReply('示例：\n```\n<output>x</output>\n```'), '示例：\n```\n<output>x</output>\n```')
  assert.equal(sanitizeReply('写成 `<output>` 就行'), '写成 `<output>` 就行')
  // 正文里正常出现的尖括号不受影响。
  assert.equal(sanitizeReply('a < b 且 c > d'), 'a < b 且 c > d')
})

test('recent image memory preserves concurrent deliveries and isolates chat/role', async () => {
  const root = await mkdtemp(join(tmpdir(), 'napcat-memory-'))
  try {
    const mem = new MemoryStore({ ctx: {}, root, backend: 'file', spacePrefix: 'test-', recentLimit: 50, injectRecent: 10, injectMaxChars: 1000, log() {} })
    await Promise.all([
      mem.appendRecent('group:42', { nick: '助手', role: 'assistant', text: '[图片]', image: 'one.png' }),
      mem.appendRecent('group:42', { nick: '助手', role: 'assistant', text: '[图片]', image: 'two.png' }),
      mem.appendRecent('group:42', { nick: 'user', text: '[图片]', image: 'user.png' }),
      mem.appendRecent('private:43', { nick: '助手', role: 'assistant', text: '[图片]', image: 'other.png' }),
    ])
    assert.deepEqual(await mem.readRecentImages('group:42'), ['one.png', 'two.png'])
    await mem.appendRecent('group:42', { nick: '助手', role: 'assistant', text: '[图片]', image: 'one.png' })
    assert.deepEqual(await mem.readRecentImages('group:42'), ['one.png', 'two.png', 'one.png'])
    assert.deepEqual(await mem.readRecentImages('private:43'), ['other.png'])
    assert.deepEqual(await mem.readRecentImages('group:42', 0), [])
    assert.deepEqual(await mem.readRecentImages('group:44'), [])
    await assert.rejects(mem.readRecentImages('group:../escape'), /Invalid chat key/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
