// TTS 自愈：首次连接被拒 → 拉起服务 → 就绪后重试一次。全程假 fetch / 假 spawn，不真起进程。
import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureTtsServer, resetTtsAutoStart, synthesizeToWav } from '../lib/tts.js'
import { makeWav } from './wav-fixture.mjs'

const config = {
  ttsEnabled: true,
  ttsServerUrl: 'http://127.0.0.1:9880',
  ttsVoiceRef: 'D:/ref/u3.wav',
  ttsEmotion: 'calm',
  ttsSpeed: 1,
  ttsTimeoutMs: 5000,
  ttsAutoStart: true,
}

const logs = []
const log = (_level, message) => logs.push(message)
const noSleep = async () => {}
const logFile = join(tmpdir(), 'dsh-napcat-test', 'tts_server.out')


const refused = () => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9880'), { code: 'ECONNREFUSED' }) })
const ok = body => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => makeWav() })

test('first fetch refused → auto start → retry succeeds once service is loaded', async () => {
  resetTtsAutoStart()
  logs.length = 0
  const spawned = []
  const urls = []
  let ttsCalls = 0
  let healthCalls = 0
  const fetchImpl = async url => {
    urls.push(String(url))
    if (String(url).includes('/health')) {
      healthCalls += 1
      // 前两次还没起来，第三次 loaded（模拟冷启动）
      return healthCalls >= 3 ? ok({ ok: true, loaded: true }) : { ok: false, status: 503, json: async () => ({ ok: false, loaded: false }) }
    }
    ttsCalls += 1
    if (ttsCalls === 1) throw refused()
    return ok(undefined)
  }
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options })
    return { on() {}, unref() {} }
  }
  const wav = await synthesizeToWav('你好', config, log, {
    fetch: fetchImpl,
    spawn: spawnImpl,
    exists: () => true,
    sleep: noSleep,
    logFile,
  })

  assert.equal(typeof wav, 'string', '首次拒绝后应重试成功')
  assert.equal(ttsCalls, 2, '只重试一次')
  assert.equal(spawned.length, 1, '只拉起一个进程')
  assert.match(spawned[0].command, /python\.exe$/)
  assert.deepEqual(spawned[0].args.slice(1), ['--port', '9880', '--warmup'])
  assert.equal(spawned[0].options.detached, true)
  assert.ok(urls.some(url => url.endsWith('/health')), '应轮询 /health')
  assert.ok(logs.some(message => /自动拉起/.test(message)))
  assert.ok(Array.isArray(spawned[0].options.stdio) && typeof spawned[0].options.stdio[1] === 'number', 'stdout/stderr 应重定向到日志文件')
})

test('concurrent callers share one auto-start attempt', async () => {
  resetTtsAutoStart()
  logs.length = 0
  let spawned = 0
  let healthCalls = 0
  const deps = {
    fetch: async url => {
      if (String(url).includes('/health')) {
        healthCalls += 1
        return healthCalls >= 2 ? ok({ ok: true, loaded: true }) : { ok: false, status: 503, json: async () => ({ ok: false, loaded: false }) }
      }
      throw refused()
    },
    spawn: () => { spawned += 1; return { on() {}, unref() {} } },
    exists: () => true,
    sleep: noSleep,
    logFile,
  }
  const results = await Promise.all([
    ensureTtsServer(config, log, deps),
    ensureTtsServer(config, log, deps),
    ensureTtsServer(config, log, deps),
  ])
  assert.deepEqual(results, [true, true, true])
  assert.equal(spawned, 1, '并发请求只能拉起一次')
  assert.equal(healthCalls, 2, '健康轮询也只跑一遍')
})

test('missing launcher path → keep the original failure, never spawn', async () => {
  resetTtsAutoStart()
  logs.length = 0
  let spawned = 0
  let ttsCalls = 0
  const fetchImpl = async url => {
    if (String(url).includes('/health')) throw refused()
    ttsCalls += 1
    throw refused()
  }
  const wav = await synthesizeToWav('你好', config, log, {
    fetch: fetchImpl,
    spawn: () => { spawned += 1; return { on() {}, unref() {} } },
    exists: () => false,
    sleep: noSleep,
    logFile,
  })
  assert.equal(wav, null, '启动器不存在时保持原有失败行为')
  assert.equal(spawned, 0, '不能起进程')
  assert.equal(ttsCalls, 1, '不重试')
  assert.ok(logs.some(message => /启动器不存在/.test(message)))
})

test('ttsAutoStart=false → no spawn, no retry', async () => {
  resetTtsAutoStart()
  let spawned = 0
  let ttsCalls = 0
  const wav = await synthesizeToWav('你好', { ...config, ttsAutoStart: false }, log, {
    fetch: async () => { ttsCalls += 1; throw refused() },
    spawn: () => { spawned += 1; return { on() {}, unref() {} } },
    exists: () => true,
    sleep: noSleep,
    logFile,
  })
  assert.equal(wav, null)
  assert.equal(spawned, 0)
  assert.equal(ttsCalls, 1)
})
