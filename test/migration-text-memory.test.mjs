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
