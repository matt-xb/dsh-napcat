import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, parseSpaceMap } from '../lib/memory.js'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'napcat-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const opts = {
    ctx: { tools: { execute() { throw new Error('file backend must not call tools') } } },
    root, backend: 'file', spacePrefix: 'test-', recentLimit: 4,
    injectRecent: 4, injectMaxChars: 2000, log() {}, ...overrides,
  }
  return { mem: new MemoryStore(opts), root, opts }
}

async function records(root, scope, file = 'history.jsonl') {
  return (await readFile(join(root, scope, file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
}

test('full bidirectional originals survive concurrent rolling writes and restart, isolated by scope', async t => {
  const { mem, root, opts } = await fixture(t)
  const full = '以前聊过火锅' + '长'.repeat(700) + '独特尾巴'
  await mem.appendRecent('private:42', { nick: '甲', text: full, at: 10000 })
  await mem.appendRecent('private:42', { nick: '助手', role: 'assistant', text: '火锅配酸梅汤', at: 20000 })
  await mem.appendRecent('private:43', { nick: '乙', text: '火锅秘密乙', at: 10000 })
  await mem.appendRecent('group:42', { nick: '丙', text: '火锅秘密群', at: 10000 })
  await Promise.all(Array.from({ length: 20 }, (_, i) => mem.appendRecent('private:42', {
    nick: '甲', text: 'ordinary ' + i, at: 30000 + i * 6000,
  })))
  const rows = await records(root, 'private-42')
  assert.equal(rows.length, 22)
  assert.equal(rows[0].text, full)
  assert.equal(rows[0].role, 'user')
  assert.equal(rows[1].role, 'assistant')
  assert.equal((await records(root, 'private-42', 'recent.jsonl')).length, 4)
  assert.ok(!(await mem.readRecent('private:42')).join('').includes('火锅'))
  const restored = new MemoryStore(opts)
  const recall = await restored.recall('private:42', '以前聊的火锅是什么')
  assert.match(recall, /独特尾巴/)
  assert.match(recall, /酸梅汤/)
  assert.doesNotMatch(recall, /秘密乙|秘密群/)
  assert.match(await restored.recall('private:43', '火锅'), /秘密乙/)
  assert.doesNotMatch(await restored.recall('private:43', '火锅'), /独特尾巴|秘密群/)
  assert.equal(await restored.recall('private:44', '火锅'), '')
})

test('legacy recent is archived before trimming; malformed rows cannot discard valid rows', async t => {
  const { mem, root, opts } = await fixture(t)
  const dir = join(root, 'group-42')
  await mkdir(dir)
  const legacy = JSON.stringify({ t: 1, nick: '旧友', text: '旧版海边约定' })
  const original = legacy + '\nbroken\nnull\n{}\n' + JSON.stringify({ t: 2, nick: '坏行', text: null }) + '\n'
  await writeFile(join(dir, 'recent.jsonl'), original)
  await Promise.all(Array.from({ length: 12 }, (_, i) => mem.appendRecent('group:42', {
    nick: '新友', text: 'ordinary ' + i, at: 10000 + i * 6000,
  })))
  const archive = await readFile(join(dir, 'history.jsonl'), 'utf8')
  assert.ok(archive.startsWith(original))
  assert.equal(archive.trim().split('\n').length, 17)
  assert.ok(!(await mem.readRecent('group:42')).join('').includes('海边'))
  assert.match(await new MemoryStore(opts).recall('group:42', '以前海边的约定'), /旧版海边约定/)
  assert.equal((await records(root, 'group-42', 'recent.jsonl')).length, 4)
  assert.equal(await mem.recall('group:42', ''), '')
})

test('existing archives are append-only; local notes and recent-only legacy data recall after restart', async t => {
  const { mem, root, opts } = await fixture(t)
  const dir = join(root, 'private-42')
  await mkdir(dir)
  const archive = 'broken\n{}\nnull\n' + JSON.stringify({ t: 1, role: 'assistant', nick: '助手', text: '旧归档森林露营' }) + '\n'
  await writeFile(join(dir, 'history.jsonl'), archive)
  await writeFile(join(dir, 'recent.jsonl'), JSON.stringify({ t: 2, nick: '旧友', text: '仅在近期的海边散步' }) + '\n')
  assert.match(await new MemoryStore(opts).recall('private:42', '以前海边散步吗'), /海边散步/)
  await mem.remember('private:42', '喜欢蘑菇炖汤')
  await mem.appendRecent('private:42', { nick: '甲', text: 'new', at: 10000 })
  assert.ok((await readFile(join(dir, 'history.jsonl'), 'utf8')).startsWith(archive))
  const restored = new MemoryStore(opts)
  assert.match(await restored.recall('private:42', '还记得森林露营吗'), /森林露营/)
  assert.match(await restored.recall('private:42', '以前蘑菇炖汤的事'), /喜欢蘑菇炖汤/)
  assert.equal(await restored.recall('group:42', '森林露营蘑菇炖汤'), '')
})

test('seed merges, time APIs and distinct successful assistant image deliveries remain compatible', async t => {
  const { mem, root } = await fixture(t, { recentLimit: 20 })
  const full = '预热消息' + '长'.repeat(700) + '预热尾巴'
  assert.equal(await mem.seedRecent('group:42', [{ nick: '', text: full, at: 10000 }]), 1)
  await mem.seedRecent('group:42', [{ nick: '旧友', text: full, at: 10000 }])
  assert.equal(await mem.recentCount('group:42'), 1)
  assert.match((await mem.readRecent('group:42')).join(''), /旧友/)
  assert.equal((await records(root, 'group-42'))[0].text, full)
  await Promise.all([0, 1].map(i => mem.appendRecent('group:42', {
    nick: '助手', role: 'assistant', text: '[图片]', image: 'synthetic.png', at: 20000 + i,
  })))
  assert.deepEqual(await mem.readRecentImages('group:42'), ['synthetic.png', 'synthetic.png'])
  assert.deepEqual(await mem.readRecentImages('private:42'), [])
  assert.deepEqual(await mem.recentTimestamps('group:42'), [10000, 20000, 20001])
  assert.equal(await mem.recentNewestAt('group:42'), 20001)
  assert.deepEqual(parseSpaceMap('group:42=synthetic-space\nprivate:43=other-space'), {
    'group:42': 'synthetic-space', 'private:43': 'other-space',
  })
})

test('mnemon ignores poisoned caches, unrelated catalogs and regex-shaped decoys', async t => {
  const calls = []
  let catalog = JSON.stringify({
    items: [{ id: 'other-space', name: 'test-private:43' }],
    unrelated: { id: 'poisoned-space', name: 'test-group:42' },
  })
  const { mem, root } = await fixture(t, {
    backend: 'mnemon', ctx: { tools: { async execute(call) {
      calls.push(call)
      return call.name === 'mnemon_memory_bodies' ? catalog : ''
    } } },
  })
  const dir = join(root, 'group-42')
  await mkdir(dir)
  await writeFile(join(dir, 'space.json'), JSON.stringify({ name: 'test-group:42', id: 'other-space' }))
  await writeFile(join(dir, 'space.cache.json'), JSON.stringify({ id: 'other-space' }))
  assert.equal(await mem.ensureSpace('group:42'), undefined)
  await mem.remember('group:42', '本群事实')
  assert.match(await readFile(join(dir, 'notes.md'), 'utf8'), /本群事实/)
  assert.equal(await mem.recall('group:42', 'unknown topic'), '')
  catalog = 'non-JSON prefix {"id":"poisoned-space","name":"test-group:42"}'
  assert.equal(await mem.ensureSpace('group:42'), undefined)
  catalog = JSON.stringify({ items: [{ id: 42, name: 'test-group:42' }] })
  assert.equal(await mem.ensureSpace('group:42'), undefined)
  assert.ok(!calls.some(call => ['mnemon_memory_body_update', 'mnemon_remember', 'mnemon_recall'].includes(call.name)))
})

test('mnemon selects only the exact scope and recalls local records before any external call', async t => {
  const calls = []
  const { mem, root, opts } = await fixture(t, {
    backend: 'mnemon', ctx: { tools: { async execute(call) {
      calls.push(call)
      if (call.name === 'mnemon_memory_bodies') return JSON.stringify({ items: [
        { id: 'other-space', name: 'test-private:43' },
        { id: 'own-space', name: 'test-private:42' },
      ] })
      return 'exact remote'
    } } },
  })
  assert.equal(await mem.recall('private:42', 'unknown topic'), 'exact remote')
  assert.deepEqual(calls.find(call => call.name === 'mnemon_recall').arguments.memoryBodyIds, ['own-space'])
  assert.ok(calls.filter(call => call.name === 'mnemon_memory_body_update').every(call => call.arguments.memoryBodyId === 'own-space'))
  await mem.appendRecent('private:42', { nick: '甲', text: 'own keyword', at: 10000 })
  calls.length = 0
  assert.match(await new MemoryStore(opts).recall('private:42', 'keyword'), /own keyword/)
  assert.equal(calls.length, 0)
  await mem.remember('private:42', '蘑菇炖汤是明确事实')
  assert.match(await readFile(join(root, 'private-42', 'notes.md'), 'utf8'), /蘑菇炖汤/)
  assert.deepEqual(calls.find(call => call.name === 'mnemon_remember').arguments.memoryBodyId, 'own-space')
  calls.length = 0
  assert.match(await new MemoryStore(opts).recall('private:42', '以前蘑菇炖汤的事'), /蘑菇炖汤/)
  assert.equal(calls.length, 0)
  const configured = new MemoryStore({ ...opts, spaces: 'group:42=explicit-space' })
  assert.equal(await configured.ensureSpace('group:42'), 'explicit-space')
  assert.equal(calls.length, 0)
})

test('invalid chat keys cannot traverse, widen scopes or bypass validation with empty queries', async t => {
  const { mem } = await fixture(t)
  for (const key of ['../group-42', 'group:42/../private-43', 'private:*', 'private:42,private:43', 'private:42\n', 'private:42:43', 'unknown:42']) {
    await assert.rejects(mem.recall(key, '火锅'), /Invalid chat key/)
    await assert.rejects(mem.recall(key, ''), /Invalid chat key/)
    await assert.rejects(mem.remember(key, 'secret'), /Invalid chat key/)
    await assert.rejects(mem.appendRecent(key, { nick: '甲', text: 'secret' }), /Invalid chat key/)
    await assert.rejects(mem.seedRecent(key, []), /Invalid chat key/)
    await assert.rejects(mem.readRecentImages(key), /Invalid chat key/)
    await assert.rejects(mem.ensureSpace(key), /Invalid chat key/)
  }
})
