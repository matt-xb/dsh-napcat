import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { findStickers } from '../lib/stickers.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
test('stickers: dynamic scope, semantic matching, hash and recent-use penalty', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'napcat-sticker-'))
  const root = await realpath(temp)
  try {
    const scope = join(root, 'from-group-42')
    const other = join(root, 'from-private-43')
    await mkdir(scope)
    await mkdir(other)
    const entry = async (directory, id, extra = {}) => {
      const path = join(directory, id + '.png')
      const bytes = Buffer.from(id)
      await writeFile(path, bytes)
      return { id, path, sha256: digest(bytes), title: '开溜', ...extra }
    }
    const shared = await entry(root, 'shared')
    const scoped = await entry(scope, 'scoped', { status: 'active', allowedChat: 'group:42' })
    const wrongHash = await entry(root, 'wrong-hash', { sha256: '0'.repeat(64) })
    const outside = await entry(other, 'outside', { status: 'active', allowedChat: 'private:43' })
    await writeFile(join(root, 'catalog.json'), JSON.stringify([shared, wrongHash, { ...outside, allowedChat: 'group:42' }]))
    await writeFile(join(scope, 'catalog.json'), JSON.stringify([scoped, { ...scoped, id: 'inactive', status: 'pending' }, { ...scoped, id: 'wrong-chat', allowedChat: 'private:43' }]))
    await writeFile(join(other, 'catalog.json'), JSON.stringify([outside]))
    assert.deepEqual(await findStickers('group:42', '下班', ''), [])
    assert.deepEqual(await findStickers('../group:42', '下班', root), [])
    const matches = await findStickers('group:42', '下班 from-private-43', root, [scoped.path])
    assert.deepEqual(matches.map(item => item.id), ['shared', 'scoped'])
    assert.equal(matches[1].recentlyUsed, true)
    assert.deepEqual((await findStickers('private:43', '下班', root)).map(item => item.id).sort(), ['outside', 'shared'])
    await writeFile(scoped.path, 'tampered')
    assert.deepEqual((await findStickers('group:42', '下班', root)).map(item => item.id), ['shared'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('stickers: redirected catalog is rejected', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'napcat-link-')))
  try {
    const catalog = join(root, 'alternate.json')
    const path = join(root, 'valid.png')
    const bytes = Buffer.from('valid')
    await writeFile(path, bytes)
    await writeFile(catalog, JSON.stringify([{ id: 'valid', path, sha256: digest(bytes), title: '下班' }]))
    try { await symlink(catalog, join(root, 'catalog.json')) }
    catch (error) { if (error.code === 'EPERM') return t.skip('symlink privilege unavailable'); throw error }
    assert.deepEqual(await findStickers('group:42', '下班', root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
