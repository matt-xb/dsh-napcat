import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A second sharp in the DSH process loads libvips 8.14 next to the host's 8.18 and makes
// every attachment read fail with ERR_DLOPEN_FAILED. semantic.js must stub it before
// @xenova/transformers is imported, because transformers imports sharp at module scope.
test('semantic: transformers import does not load the bundled sharp', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'napcat-semantic-'))
  try {
    const lib = join(temp, 'lib')
    const sharpDir = join(temp, 'node_modules', 'sharp')
    const transformersDir = join(temp, 'node_modules', '@xenova', 'transformers')
    await mkdir(lib, { recursive: true })
    await mkdir(sharpDir, { recursive: true })
    await mkdir(transformersDir, { recursive: true })
    await copyFile(new URL('../lib/semantic.js', import.meta.url), join(lib, 'semantic.js'))

    await writeFile(join(sharpDir, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.32.6', main: 'index.cjs' }))
    await writeFile(join(sharpDir, 'index.cjs'),
      "globalThis.__sharpLoaded = true;\nmodule.exports = () => { throw new Error('native sharp must stay unloaded') };\n")
    await writeFile(join(transformersDir, 'package.json'), JSON.stringify({ name: '@xenova/transformers', version: '2.17.2', type: 'module', main: 'index.js' }))
    await writeFile(join(transformersDir, 'index.js'), [
      "import sharp from 'sharp'",
      "export const env = {}",
      "export async function pipeline() {",
      "  if (typeof sharp !== 'function') throw new Error('sharp stub not installed')",
      "  return async texts => ({ dims: [texts.length, 4], data: new Float32Array(texts.length * 4).fill(1) })",
      "}",
      "",
    ].join('\n'))

    const { semanticScores } = await import(pathToFileURL(join(lib, 'semantic.js')).href)
    const scores = await semanticScores([{ id: 'a|1', text: '累了 摸鱼 躺平' }], '累死了一天', join(temp, 'cache'))

    assert.equal(globalThis.__sharpLoaded, undefined, 'the bundled sharp must never load')
    assert.equal(scores.size, 1, 'semantic scoring still runs on the stubbed module')
  } finally {
    delete globalThis.__sharpLoaded
    await rm(temp, { recursive: true, force: true })
  }
})
