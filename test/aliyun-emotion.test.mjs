// 云端 TTS 情绪：Qwen-Audio-TTS 才加情感标签和 instruction，老模型必须原样。
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'

import { synthesizeAliyun } from '../lib/aliyun.js'
import { makeWav } from './wav-fixture.mjs'

const logs = []
const log = (level, message) => logs.push({ level, message })


const baseConfig = {
  aliyunApiKey: 'sk-test',
  aliyunAsrModel: 'qwen3-asr-flash',
  aliyunTtsModel: 'qwen3-tts-flash',
  aliyunTtsVoice: 'Cherry',
  aliyunTtsInstruction: '',
  voiceTimeoutMs: 5000,
  ttsTimeoutMs: 5000,
}

/** 假 fetch：合成请求记到 seen，下载请求回 RIFF 字节。 */
function fakeFetch(seen) {
  return async (url, init) => {
    if (seen.request === undefined) seen.request = { url: String(url), body: JSON.parse(init.body) }
    if (String(url).startsWith('https://oss.example.com/')) {
      return { ok: true, status: 200, arrayBuffer: async () => makeWav() }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output: { audio: { url: 'https://oss.example.com/a.wav', data: '' } } }),
    }
  }
}

// 表驱动：模型 × 情绪 × 原始文本 → 端点与 text 前缀。
const CASES = [
  { name: '老模型 happy 不加标签', model: 'qwen3-tts-flash', emotion: 'happy', text: '你好', endpoint: 'multimodal-generation', expect: '你好' },
  { name: '老模型 angry 不加标签', model: 'qwen3-tts-flash', emotion: 'angry', text: '你好', endpoint: 'multimodal-generation', expect: '你好' },
  { name: '新模型 happy → [excited]', model: 'qwen-audio-3.1-tts-flash', emotion: 'happy', text: '你好', endpoint: 'SpeechSynthesizer', expect: '[excited]你好' },
  { name: '新模型 中文别名 高兴 → [excited]', model: 'qwen-audio-3.1-tts-flash', emotion: '高兴', text: '你好', endpoint: 'SpeechSynthesizer', expect: '[excited]你好' },
  { name: '新模型 sad → [sad]', model: 'qwen-audio-3.1-tts-flash', emotion: 'sad', text: '你好', endpoint: 'SpeechSynthesizer', expect: '[sad]你好' },
  { name: '新模型 disgusted → [scornful]', model: 'qwen-audio-3.1-tts-flash', emotion: 'disgusted', text: '你好', endpoint: 'SpeechSynthesizer', expect: '[scornful]你好' },
  { name: '新模型 calm 不加标签', model: 'qwen-audio-3.1-tts-flash', emotion: 'calm', text: '你好', endpoint: 'SpeechSynthesizer', expect: '你好' },
  { name: '新模型 平静 不加标签', model: 'qwen-audio-3.1-tts-flash', emotion: '平静', text: '你好', endpoint: 'SpeechSynthesizer', expect: '你好' },
  { name: '新模型 情绪空不加标签', model: 'qwen-audio-3.1-tts-flash', emotion: '', text: '你好', endpoint: 'SpeechSynthesizer', expect: '你好' },
  { name: '新模型 已带标签不重复插入', model: 'qwen-audio-3.1-tts-flash', emotion: 'happy', text: '[sad]你好', endpoint: 'SpeechSynthesizer', expect: '[sad]你好' },
  { name: '新模型 已带标签(大小写)不重复插入', model: 'qwen-audio-3.1-tts-flash', emotion: 'angry', text: '[Excited]你好', endpoint: 'SpeechSynthesizer', expect: '[Excited]你好' },
  { name: '新模型 普通方括号不算标签', model: 'qwen-audio-3.1-tts-flash', emotion: 'happy', text: '[第二段]你好', endpoint: 'SpeechSynthesizer', expect: '[excited][第二段]你好' },
  { name: '3.0 新模型也支持标签', model: 'qwen-audio-3.0-tts-flash', emotion: 'surprised', text: '你好', endpoint: 'SpeechSynthesizer', expect: '[amazed]你好' },
]

test('情绪标签：按模型能力决定是否插入', async () => {
  for (const item of CASES) {
    const config = { ...baseConfig, aliyunTtsModel: item.model, ttsEmotion: item.emotion }
    const seen = {}
    const wav = await synthesizeAliyun(item.text, config, log, { fetch: fakeFetch(seen) })
    try {
      assert.notEqual(wav, null, item.name + '：应当合成成功')
      assert.ok(seen.request !== undefined)
      assert.ok(seen.request.url.includes(item.endpoint), item.name + '：端点不对 ' + seen.request.url)
      assert.equal(seen.request.body.model, item.model, item.name + '：模型')
      assert.equal(seen.request.body.input.text, item.expect, item.name + '：文本')
    } finally {
      if (wav !== null) await rm(wav, { force: true })
    }
  }
})

test('老模型的请求体保持 language_type，没有 format/instruction', async () => {
  const config = { ...baseConfig, ttsEmotion: 'happy' }
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    assert.deepEqual(seen.request.body.input, { text: '你好', voice: 'Cherry', language_type: 'Chinese' })
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('新模型 instruction 留空则不传', async () => {
  const config = { ...baseConfig, aliyunTtsModel: 'qwen-audio-3.1-tts-flash', aliyunTtsVoice: 'longanhuan_v3.1' }
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    const input = seen.request.body.input
    assert.equal('instruction' in input, false)
    assert.equal(input.format, 'wav')
    assert.equal(input.sample_rate, 24000)
    assert.equal('language_type' in input, false)
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('新模型 instruction 原样透传', async () => {
  const config = {
    ...baseConfig,
    aliyunTtsModel: 'qwen-audio-3.1-tts-flash',
    aliyunTtsVoice: 'longanhuan_v3.1',
    aliyunTtsInstruction: '请讲上海话。',
    ttsEmotion: 'happy',
  }
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    assert.equal(seen.request.body.input.instruction, '请讲上海话。')
    assert.equal(seen.request.body.input.text, '[excited]你好')
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('音色与模型错配时只 warn 不拦请求', async () => {
  const config = { ...baseConfig, aliyunTtsModel: 'qwen-audio-3.1-tts-flash', aliyunTtsVoice: 'Nini' }
  logs.length = 0
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    assert.notEqual(wav, null, '错配音色也要照常发请求')
    assert.ok(logs.some(item => item.level === 'warn' && item.message.includes('_v3.1')))
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('标签计入 600 字上限', async () => {
  const config = { ...baseConfig, aliyunTtsModel: 'qwen-audio-3.1-tts-flash', aliyunTtsVoice: 'longanhuan_v3.1', ttsEmotion: 'happy' }
  let called = 0
  const fetch = async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' } }
  // 正文 598 字 + 9 字标签（[excited]）= 607 > 600
  logs.length = 0
  assert.equal(await synthesizeAliyun('字'.repeat(598), config, log, { fetch }), null)
  assert.equal(called, 0)
  assert.ok(logs.some(item => item.message.includes('600')))
})

test('不支持标签的模型遇到情绪时 warn 一句（避免以为参数生效）', async () => {
  logs.length = 0
  const config = { ...baseConfig, aliyunTtsModel: 'qwen3-tts-flash', ttsEmotion: 'happy' }
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    assert.equal(seen.request.body.input.text, '你好', '标签仍然不插入')
    assert.ok(logs.some(item => item.level === 'warn' && item.message.includes('不支持情感标签')))
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('calm 且模型不支持标签时不 warn（本来就没情绪）', async () => {
  logs.length = 0
  const config = { ...baseConfig, aliyunTtsModel: 'qwen3-tts-flash', ttsEmotion: 'calm' }
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    assert.equal(logs.some(item => item.message.includes('不支持情感标签')), false)
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})
