import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, resolveConfig } from '../lib/config.js'

test('stickerRoot defaults empty and resolves volatile values without a personal path', () => {
  assert.equal(DEFAULTS.stickerRoot, '')
  assert.equal(resolveConfig({}).stickerRoot, '')
  assert.equal(resolveConfig({ stickerRoot: { get: () => 'approved-stickers' } }).stickerRoot, 'approved-stickers')
  assert.equal(resolveConfig({ stickerRoot: 'approved-stickers' }).stickerRoot, 'approved-stickers')
})
