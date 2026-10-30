// wav 头修复：阿里云流式返回的 RIFF/data 尺寸是占位值，落盘前要按真实字节改写，退化音频要拒收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'

import { normalizeWav, parseWav } from '../lib/wav.js'
import { synthesizeAliyun } from '../lib/aliyun.js'
import { synthesizeToWav } from '../lib/tts.js'
import { makeWav } from './wav-fixture.mjs'

const logs = []
const log = (level, message) => logs.push({ level, message })

const baseConfig = {
  aliyunApiKey: 'sk-test',
  aliyunTtsModel: 'qwen3-tts-flash',
  aliyunTtsVoice: 'Cherry',
  ttsTimeoutMs: 5000,
}

function fetchAudio(buffer) {
  return async () => ({ ok: true, status: 200, arrayBuffer: async () => buffer })
}

function fetchTts(buffer) {
  const json = { output: { audio: { url: 'https://example.com/a.wav', data: '' } } }
  let call = 0
  return async () => {
    call += 1
    if (call === 1) return { ok: true, status: 200, text: async () => JSON.stringify(json) }
    return { ok: true, status: 200, arrayBuffer: async () => buffer }
  }
}

test('parseWav 认出占位头时按实际字节算 data 长度', () => {
  const info = parseWav(makeWav(960, { placeholderHeader: true }))
  assert.equal(info.channels, 1)
  assert.equal(info.sampleRate, 24000)
  assert.equal(info.bitsPerSample, 16)
  assert.equal(info.dataOffset, 44)
  assert.equal(info.dataLength, 1920, '声明 0x7FFFFF9B，实际只有 960 采样')
})

test('normalizeWav 把 RIFF/data 尺寸回填成真实值，音频字节不动', () => {
  const original = makeWav(960, { placeholderHeader: true })
  const { buffer, fixed } = normalizeWav(original)
  assert.equal(fixed, true)
  assert.equal(buffer.readUInt32LE(4), buffer.length - 8, 'RIFF size 要回填')
  assert.equal(buffer.readUInt32LE(40), 1920, 'data size 要回填')
  assert.deepEqual(buffer.subarray(44), original.subarray(44), '尾部音频不能改一个字节')
  assert.equal(original.readUInt32LE(40), 2147483547, '原 buffer 不能被就地改')
})

test('normalizeWav 对本来就正确的头不改动', () => {
  const good = makeWav(480)
  const { buffer, fixed } = normalizeWav(good)
  assert.equal(fixed, false)
  assert.equal(buffer, good)
})

test('空壳 wav（fmt 块全零）被拒，不再当成语音发出去', () => {
  const stub = Buffer.alloc(48)
  stub.write('RIFF', 0, 'latin1')
  stub.writeUInt32LE(40, 4)
  stub.write('WAVEfmt ', 8, 'latin1')
  stub.write('data', 36, 'latin1')
  stub.writeUInt32LE(4, 40)
  assert.throws(() => normalizeWav(stub), /fmt/)
})

test('只有头没有音频帧的 wav 被拒', () => {
  const empty = makeWav(480).subarray(0, 44)
  assert.throws(() => normalizeWav(empty), /data|音频帧/)
})

test('synthesizeAliyun 落盘的 wav 头是真实长度（不是 0x7FFFFFFF）', async () => {
  logs.length = 0
  const wav = await synthesizeAliyun('你好', baseConfig, log, { fetch: fetchTts(makeWav(960, { placeholderHeader: true })) })
  assert.equal(typeof wav, 'string')
  try {
    const buffer = await readFile(wav)
    assert.equal(buffer.length, 44 + 1920, '音频字节一个不少')
    assert.equal(buffer.readUInt32LE(40), 1920, 'data size 必须是真实值')
    assert.equal(buffer.readUInt32LE(4), buffer.length - 8)
  } finally {
    await rm(wav, { force: true })
  }
})

test('synthesizeAliyun 拿到空壳 wav 时返回 null，不写坏文件', async () => {
  logs.length = 0
  const stub = Buffer.alloc(48)
  stub.write('RIFF', 0, 'latin1')
  stub.writeUInt32LE(40, 4)
  stub.write('WAVEfmt ', 8, 'latin1')
  stub.write('data', 36, 'latin1')
  stub.writeUInt32LE(4, 40)
  const wav = await synthesizeAliyun('你好', baseConfig, log, { fetch: fetchTts(stub) })
  assert.equal(wav, null)
  assert.ok(logs.some(item => item.level === 'warn' && /fmt/.test(item.message)), '失败要留在日志里')
})

test('本机 TTS 分支同样回填占位头', async () => {
  logs.length = 0
  const config = { ...baseConfig, voiceTtsProvider: 'local', ttsVoiceRef: 'D:/ref/a.wav' }
  const wav = await synthesizeToWav('你好', config, log, { fetch: fetchAudio(makeWav(960, { placeholderHeader: true })) })
  assert.equal(typeof wav, 'string')
  try {
    const buffer = await readFile(wav)
    assert.equal(buffer.readUInt32LE(40), 1920)
    assert.equal(buffer.readUInt32LE(4), buffer.length - 8)
  } finally {
    await rm(wav, { force: true })
  }
})
