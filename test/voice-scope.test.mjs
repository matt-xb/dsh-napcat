// 音色按会话隔离：两个 chatKey 各自 switch 互不影响；持久化写盘 → 清缓存 → 读回；未设覆盖回落到 config.ttsVoice。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { registerTools } from '../lib/tools.js'
import {
  currentVoiceName,
  resetVoiceOverride,
  resolveVoiceRef,
} from '../lib/ttsvoice.js'
import {
  getStoredVoice,
  loadVoiceStore,
  resetVoiceStore,
  setStoredVoice,
} from '../lib/voicestore.js'

const PRESETS = { '原版': 'D:/ref/original_ref.wav', '银月': 'D:/ref/yinyue_ref_n24.wav' }
const log = () => {}
const tmp = () => mkdtemp(join(tmpdir(), 'dsh-voice-'))

function makeTools(config) {
  const tools = new Map()
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, on: () => () => {} }
  registerTools(ctx, { call: async () => ({}) }, log, { getConfig: () => config })
  return tools.get('napcat_voice')
}

test('音色隔离：私聊与群各自 switch，互不影响', async () => {
  const dir = await tmp()
  try {
    resetVoiceStore()
    resetVoiceOverride()
    const config = resolveConfig({ ttsVoices: PRESETS, ttsVoice: '银月', workspacePath: dir })
    const voice = makeTools(config)

    assert.equal(
      await voice.execute({ action: 'switch', name: '原版', chat_id: 'private:993484108' }, {}),
      '已把 private:993484108 切换到 原版',
    )
    assert.equal(
      await voice.execute({ action: 'switch', name: '银月', chat_id: 'group:123456789' }, {}),
      '已把 group:123456789 切换到 银月',
    )

    assert.equal(currentVoiceName(config, 'private:993484108'), '原版')
    assert.equal(currentVoiceName(config, 'group:123456789'), '银月')
    assert.equal(resolveVoiceRef(config, 'private:993484108'), PRESETS['原版'])
    assert.equal(resolveVoiceRef(config, 'group:123456789'), PRESETS['银月'])

    // 第三个会话没设过覆盖 → 回落到配置的 ttsVoice（银月）
    assert.equal(currentVoiceName(config, 'group:999999999'), '银月')
    assert.equal(resolveVoiceRef(config, 'group:999999999'), PRESETS['银月'])
    // 不传 chatKey 的老行为也还是配置值
    assert.equal(currentVoiceName(config), '银月')

    const saved = JSON.parse(await readFile(join(dir, 'voice-presets.json'), 'utf8'))
    assert.deepEqual(saved, { 'group:123456789': '银月', 'private:993484108': '原版' })
  } finally {
    resetVoiceStore()
    resetVoiceOverride()
    await rm(dir, { recursive: true, force: true })
  }
})

test('持久化：写盘后清内存缓存能读回', async () => {
  const dir = await tmp()
  try {
    resetVoiceStore()
    resetVoiceOverride()
    const config = resolveConfig({ ttsVoices: PRESETS, ttsVoice: '银月', workspacePath: dir })

    await setStoredVoice(config, log, 'private:993484108', '银月')
    await setStoredVoice(config, log, 'group:123456789', '原版')
    assert.equal(getStoredVoice('private:993484108'), '银月')

    resetVoiceStore() // 清内存 + 清"已加载"标记
    assert.equal(getStoredVoice('private:993484108'), undefined)
    await loadVoiceStore(config, log)
    assert.equal(getStoredVoice('private:993484108'), '银月')
    assert.equal(getStoredVoice('group:123456789'), '原版')
    assert.equal(currentVoiceName(config, 'group:123456789'), '原版')

    // 损坏文件只 warn 不抛，按空处理
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(join(dir, 'voice-presets.json'), '{ 坏掉的 json', 'utf8')
    resetVoiceStore()
    const warnings = []
    await loadVoiceStore(config, (level, message) => warnings.push(level + ':' + message))
    assert.equal(getStoredVoice('private:993484108'), undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^warn:/)
  } finally {
    resetVoiceStore()
    resetVoiceOverride()
    await rm(dir, { recursive: true, force: true })
  }
})

test('未设置覆盖的会话回落到 config.ttsVoice', async () => {
  resetVoiceStore()
  resetVoiceOverride()
  const config = resolveConfig({ ttsVoices: PRESETS, ttsVoice: '原版', ttsVoiceRef: 'D:/ref/legacy.wav' })
  assert.equal(currentVoiceName(config, 'group:777'), '原版')
  assert.equal(resolveVoiceRef(config, 'group:777'), PRESETS['原版'])

  // 旧配置没有预设：回落到 ttsVoiceRef，再空则内置兜底
  const legacy = resolveConfig({ ttsVoices: {}, ttsVoice: '银月', ttsVoiceRef: 'D:/ref/legacy.wav' })
  assert.equal(resolveVoiceRef(legacy, 'private:1'), 'D:/ref/legacy.wav')
  const empty = resolveConfig({ ttsVoices: {}, ttsVoice: '', ttsVoiceRef: '' })
  assert.equal(resolveVoiceRef(empty, 'private:1'), 'D:/NapCat/tts/refs/user/yinyue_ref_n24.wav')
})
