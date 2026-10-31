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

// 表驱动：音色（决定模型）× 情绪 × 原始文本 → 端点与 text 前缀。
// 不带后缀的音色走 qwen3-tts-flash，带 _v3.1 的走 qwen-audio-3.1-tts-flash。
const CASES = [
  { name: '普通音色 happy 不加标签', voice: 'Cherry', emotion: 'happy', text: '你好', endpoint: 'multimodal-generation', model: 'qwen3-tts-flash', expect: '你好' },
  { name: '普通音色 angry 不加标签', voice: 'Nini', emotion: 'angry', text: '你好', endpoint: 'multimodal-generation', model: 'qwen3-tts-flash', expect: '你好' },
  { name: '3.1 音色 happy → [excited]', voice: 'longanhuan_v3.1', emotion: 'happy', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[excited]你好' },
  { name: '3.1 音色 中文别名 高兴 → [excited]', voice: 'longanhuan_v3.1', emotion: '高兴', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[excited]你好' },
  { name: '3.1 音色 sad → [sad]', voice: 'longanhuan_v3.1', emotion: 'sad', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[sad]你好' },
  { name: '3.1 音色 disgusted → [scornful]', voice: 'longanhuan_v3.1', emotion: 'disgusted', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[scornful]你好' },
  { name: '3.1 音色 calm 不加标签', voice: 'longanhuan_v3.1', emotion: 'calm', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '你好' },
  { name: '3.1 音色 平静 不加标签', voice: 'longanhuan_v3.1', emotion: '平静', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '你好' },
  { name: '3.1 音色 情绪空不加标签', voice: 'longanhuan_v3.1', emotion: '', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '你好' },
  { name: '3.1 音色 已带标签不重复插入', voice: 'longanhuan_v3.1', emotion: 'happy', text: '[sad]你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[sad]你好' },
  { name: '3.1 音色 已带标签(大小写)不重复插入', voice: 'longanhuan_v3.1', emotion: 'angry', text: '[Excited]你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[Excited]你好' },
  { name: '3.1 音色 普通方括号不算标签', voice: 'longanhuan_v3.1', emotion: 'happy', text: '[第二段]你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[excited][第二段]你好' },
  { name: '别的 _v3.1 音色同样走 Audio-TTS', voice: 'longxiaobai_v3.1', emotion: 'surprised', text: '你好', endpoint: 'SpeechSynthesizer', model: 'qwen-audio-3.1-tts-flash', expect: '[amazed]你好' },
]

test('情绪标签：音色决定模型，模型决定是否插入标签', async () => {
  for (const item of CASES) {
    // 配置里的 model 故意写死成 qwen3-tts-flash，证明 _v3.1 音色不会被它带偏。
    const config = { ...baseConfig, aliyunTtsModel: 'qwen3-tts-flash', aliyunTtsVoice: item.voice, ttsEmotion: item.emotion }
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
  const config = { ...baseConfig, aliyunTtsVoice: 'longanhuan_v3.1' }
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

test('音色留空时 aliyunTtsModel 当兜底，错配只 warn 不拦请求', async () => {
  const config = { ...baseConfig, aliyunTtsModel: 'qwen-audio-3.1-tts-flash', aliyunTtsVoice: '  ' }
  logs.length = 0
  const seen = {}
  const wav = await synthesizeAliyun('你好', config, log, { fetch: fakeFetch(seen) })
  try {
    assert.notEqual(wav, null, '错配音色也要照常发请求')
    assert.equal(seen.request.body.model, 'qwen-audio-3.1-tts-flash', '音色为空才用配置里的模型')
    assert.equal(seen.request.body.input.voice, 'Cherry', '音色为空时兜底 Cherry')
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
