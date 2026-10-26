/**
 * 语音转文字（"耳朵"）：QQ 语音段 → OneBot get_record（服务端转 wav）→ whisper.cpp 出文本。
 *
 * 不引第三方依赖：转码用 NapCat 自带的 ffmpeg addon（get_record 的 out_format），
 * 识别用本机 whisper-cli 子进程。任何一步失败都抛错，由调用方回退 [语音] 占位符。
 */

import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from './config.js'
import { base64UrlToBuffer, ensureTempDir } from './media.js'
import type { LogLevel, OneBotConnection } from './onebot.js'

type Log = (level: LogLevel, message: string) => void

/** 串行队列：whisper 每次都要加载整个模型，并发跑只会互相抢显存/内存。 */
let queue: Promise<unknown> = Promise.resolve()
/** 排队中的条数。积压到上限直接放弃，免得一条语音把后面每条都拖几十秒。 */
let pending = 0
const MAX_PENDING = 2

/** 把一条语音转成文本；失败/超时直接抛错。调用方负责兜底。 */
export function transcribeRecord(conn: OneBotConnection, fileRef: string, config: Config, log: Log): Promise<string> {
  if (pending >= MAX_PENDING) return Promise.reject(new Error('语音识别排队已满（' + pending + ' 条），跳过'))
  pending += 1
  const run = queue.then(() => transcribeOnce(conn, fileRef, config, log)).finally(() => { pending -= 1 })
  queue = run.catch(() => undefined)
  return run
}

async function transcribeOnce(conn: OneBotConnection, fileRef: string, config: Config, log: Log): Promise<string> {
  const dir = await ensureTempDir()
  const stem = join(dir, 'voice-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
  const wav = stem + '.wav'
  try {
    // get_record 的 out_format 分支会自己 readFile 再回 base64，不受 enableLocalFile2Url 影响
    const info = await conn.call<{ base64?: string }>('get_record', { file: fileRef, out_format: 'wav' })
    const raw = typeof info?.base64 === 'string' ? info.base64 : ''
    if (raw === '') throw new Error('get_record 没有返回 base64')
    await writeFile(wav, base64UrlToBuffer(raw))
    await runWhisper(config.voiceWhisperBin, [
      '-m', config.voiceWhisperModel,
      '-f', wav,
      '-l', config.voiceLanguage,
      '-nt', '-otxt', '-of', stem,
    ], config.voiceTimeoutMs)
    const text = (await readFile(stem + '.txt', 'utf8')).replace(/\s+/g, ' ').trim()
    if (text === '') throw new Error('whisper 没有识别出文字')
    log('debug', '语音转写: ' + text)
    return text
  } finally {
    await rm(wav, { force: true }).catch(() => undefined)
    await rm(stem + '.txt', { force: true }).catch(() => undefined)
  }
}

/** 跑 whisper-cli，超时强杀。stdout 不用（-otxt 已写文件），只留 stderr 用于报错。 */
function runWhisper(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error === undefined) resolve()
      else reject(error)
    }
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      done(new Error('whisper 超时（' + timeoutMs + 'ms）'))
    }, timeoutMs)
    child.stderr.on('data', chunk => {
      if (stderr.length < 2000) stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      done(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      done(code === 0 ? undefined : new Error('whisper 退出码 ' + String(code) + '：' + stderr.trim().slice(-300)))
    })
  })
}
