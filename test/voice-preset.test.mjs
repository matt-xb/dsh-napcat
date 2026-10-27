// 音色预设：解析优先级（运行时覆盖 > ttsVoices[ttsVoice] > ttsVoiceRef）+ napcat_voice 工具。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../lib/config.js'
import { registerTools } from '../lib/tools.js'
import { currentVoiceName, resetVoiceOverride, resolveVoiceRef, setVoiceOverride } from '../lib/ttsvoice.js'
import { synthesizeToWav } from '../lib/tts.js'

const PRESETS = { '原版': 'D:/ref/original_ref.wav', '银月': 'D:/ref/yinyue_ref_n24.wav' }
const log = () => {}

test('音色解析：运行时覆盖 > ttsVoices[ttsVoice] > ttsVoiceRef', async () => {
  resetVoiceOverride()
  const config = resolveConfig({ ttsVoices: PRESETS, ttsVoice: '银月', ttsVoiceRef: 'D:/ref/legacy.wav' })
  assert.equal(resolveVoiceRef(config), PRESETS['银月'], '默认取 ttsVoices[ttsVoice]')
  assert.equal(currentVoiceName(config), '银月')

  setVoiceOverride('原版')
  assert.equal(resolveVoiceRef(config), PRESETS['原版'], '运行时覆盖优先于配置')
  assert.equal(currentVoiceName(config), '原版')

  setVoiceOverride('不存在')
  assert.equal(resolveVoiceRef(config), PRESETS['银月'], '未知覆盖名不生效')

  // 旧配置没有 ttsVoices：退回 ttsVoiceRef
  resetVoiceOverride()
  const legacy = resolveConfig({ ttsVoices: {}, ttsVoice: '银月', ttsVoiceRef: 'D:/ref/legacy.wav' })
  assert.equal(resolveVoiceRef(legacy), 'D:/ref/legacy.wav')
  const empty = resolveConfig({ ttsVoices: {}, ttsVoice: '', ttsVoiceRef: '' })
  assert.equal(resolveVoiceRef(empty), 'D:/NapCat/tts/refs/user/yinyue_ref_n24.wav', '全空时用内置兜底')

  // 合成请求里真的带上解析后的路径
  resetVoiceOverride()
  setVoiceOverride('原版')
  let voice = ''
  const wav = await synthesizeToWav('你好', config, log, {
    fetch: async url => {
      voice = new URL(String(url)).searchParams.get('voice') ?? ''
      const buffer = Buffer.alloc(48)
      buffer.write('RIFF', 0, 'latin1')
      buffer.write('data', 36, 'latin1')
      return { ok: true, status: 200, arrayBuffer: async () => buffer }
    },
  })
  assert.equal(typeof wav, 'string')
  assert.equal(voice, PRESETS['原版'], 'TTS 请求用运行时音色')
  resetVoiceOverride()
})

test('napcat_voice：list / switch / 非法名字报错', async () => {
  resetVoiceOverride()
  const tools = new Map()
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, on: () => () => {} }
  registerTools(ctx, { call: async () => ({}) }, log, {
    getConfig: () => resolveConfig({ ttsVoices: PRESETS, ttsVoice: '银月' }),
  })
  const voice = tools.get('napcat_voice')
  assert.ok(voice, '应注册 napcat_voice')

  assert.equal(await voice.execute({ action: 'list' }, {}), '当前：银月。可选：原版、银月')

  assert.equal(await voice.execute({ action: 'switch', name: '原版' }, {}), '已切换到 原版')
  assert.equal(await voice.execute({ action: 'list' }, {}), '当前：原版。可选：原版、银月')

  await assert.rejects(voice.execute({ action: 'switch', name: '银月x' }, {}), /可选：原版、银月/)
  await assert.rejects(voice.execute({ action: 'switch' }, {}), /需要 name/)
  await assert.rejects(voice.execute({ action: 'reset' }, {}), /action 应为 list 或 switch/)
  resetVoiceOverride()
})
