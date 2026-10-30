// 阿里云百炼语音：假 fetch 验证请求形状与失败回退，不联网、不需要真 key。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'

import { synthesizeAliyun, transcribeAliyun } from '../lib/aliyun.js'
import { synthesizeToWav } from '../lib/tts.js'
import { transcribeRecord } from '../lib/voice.js'
import { makeWav } from './wav-fixture.mjs'

const logs = []
const log = (level, message) => logs.push({ level, message })


const baseConfig = {
  aliyunApiKey: 'sk-test',
  aliyunAsrModel: 'qwen3-asr-flash',
  aliyunTtsModel: 'qwen3-tts-flash',
  aliyunTtsVoice: 'Cherry',
  voiceTimeoutMs: 5000,
  ttsTimeoutMs: 5000,
}

function recordCalls(fetchImpl) {
  const calls = []
  const wrapped = async (url, init) => {
    calls.push({ url: String(url), init })
    return await fetchImpl(String(url), init)
  }
  return { calls, fetch: wrapped }
}

test('transcribeAliyun 用 OpenAI 兼容端点并取 choices[0].message.content', async () => {
  logs.length = 0
  const { calls, fetch } = recordCalls(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: ' 你好  呀 ' } }] }),
  }))
  const text = await transcribeAliyun(makeWav(), baseConfig, log, { fetch })
  assert.equal(text, '你好 呀')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/compatible-mode\/v1\/chat\/completions$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'qwen3-asr-flash')
  assert.equal(body.stream, false)
  const data = body.messages[0].content[0].input_audio.data
  assert.match(data, /^data:audio\/wav;base64,/)
})

test('transcribeAliyun 没配 key 直接抛错，不发请求', async () => {
  let called = 0
  const fetch = async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' } }
  await assert.rejects(() => transcribeAliyun(makeWav(), { ...baseConfig, aliyunApiKey: '' }, log, { fetch }), /aliyunApiKey/)
  assert.equal(called, 0)
})

test('transcribeAliyun 返回错误码时抛错并带上 code/message', async () => {
  const fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }),
  })
  await assert.rejects(() => transcribeAliyun(makeWav(), baseConfig, log, { fetch }), /HTTP 401：InvalidApiKey/)
})

test('synthesizeAliyun 先取 audio.url 再下载，落成 wav 文件', async () => {
  logs.length = 0
  const { calls, fetch } = recordCalls(async url => {
    if (url.startsWith('https://oss.example.com/')) {
      return { ok: true, status: 200, arrayBuffer: async () => makeWav() }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output: { audio: { url: 'https://oss.example.com/a.wav', data: '' } }, usage: { characters: 2 } }),
    }
  })
  const wav = await synthesizeAliyun('你好', baseConfig, log, { fetch })
  try {
    assert.ok(wav !== null && wav.endsWith('.wav'))
    assert.equal((await readFile(wav)).subarray(0, 4).toString('latin1'), 'RIFF')
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'qwen3-tts-flash')
    assert.deepEqual(body.input, { text: '你好', voice: 'Cherry', language_type: 'Chinese' })
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('synthesizeAliyun 超 600 字符不请求，直接返回 null', async () => {
  logs.length = 0
  let called = 0
  const fetch = async () => { called += 1; return { ok: true, status: 200, text: async () => '{}' } }
  assert.equal(await synthesizeAliyun('字'.repeat(601), baseConfig, log, { fetch }), null)
  assert.equal(called, 0)
  assert.ok(logs.some(item => item.message.includes('600')))
})

test('synthesizeAliyun 云端报错返回 null（不抛），让上层回退文字', async () => {
  logs.length = 0
  const fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ code: 'Throttling', message: 'Requests rate limit exceeded' }) })
  assert.equal(await synthesizeAliyun('你好', baseConfig, log, { fetch }), null)
  assert.ok(logs.some(item => item.level === 'warn' && item.message.includes('Throttling')))
})

test('voiceTtsProvider=aliyun 时 synthesizeToWav 走云端，不碰本机 TTS 服务', async () => {
  logs.length = 0
  const urls = []
  const fetch = async (url) => {
    urls.push(String(url))
    if (String(url).startsWith('https://oss.example.com/')) {
      return { ok: true, status: 200, arrayBuffer: async () => makeWav() }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output: { audio: { url: 'https://oss.example.com/a.wav', data: '' } } }),
    }
  }
  const config = { ...baseConfig, voiceTtsProvider: 'aliyun', ttsEnabled: true, ttsServerUrl: 'http://127.0.0.1:9880' }
  const wav = await synthesizeToWav('你好', config, log, { fetch })
  try {
    assert.ok(wav !== null)
    assert.ok(urls.every(url => !url.includes('127.0.0.1')), '不应请求本机 TTS：' + urls.join(','))
    assert.ok(urls.some(url => url.includes('multimodal-generation')))
  } finally {
    if (wav !== null) await rm(wav, { force: true })
  }
})

test('voiceAsrProvider=aliyun 时 transcribeRecord 走云端，不起 whisper 子进程', async () => {
  logs.length = 0
  const urls = []
  const fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '云端识别结果' } }] }) }
  }
  const conn = { call: async (action) => ({ base64: 'data:audio/wav;base64,' + makeWav().toString('base64'), action }) }
  const config = {
    ...baseConfig,
    voiceAsrProvider: 'aliyun',
    // 故意指向不存在的 whisper，证明云端分支根本没调用它
    voiceWhisperBin: 'Z:/definitely-missing/whisper-cli.exe',
    voiceWhisperModel: 'Z:/definitely-missing/model.bin',
    voiceLanguage: 'zh',
  }
  const text = await transcribeRecord(conn, 'abc.amr', config, log, { fetch })
  assert.equal(text, '云端识别结果')
  assert.equal(urls.length, 1)
  assert.match(urls[0], /compatible-mode/)
})
