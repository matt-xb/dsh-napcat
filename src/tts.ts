/**
 * 文字转语音（"嘴"）：本机 IndexTTS 服务（HTTP）合成 wav，供 napcat_send_voice 发 record 段。
 *
 * 不引第三方依赖：直接 fetch 本地 /tts。任何一步失败都返回 null 并记日志，由调用方降级。
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from './config.js'
import { ensureTempDir } from './media.js'
import { withGpu } from './gpu.js'
import type { LogLevel } from './onebot.js'

type Log = (level: LogLevel, message: string) => void

/** 八维情绪（顺序与 TTS 服务一致）：happy,angry,sad,afraid,disgusted,melancholic,surprised,calm */
const EMOTIONS: Record<string, string> = {
  happy: '1,0,0,0,0,0,0,0',
  angry: '0,1,0,0,0,0,0,0',
  sad: '0,0,1,0,0,0,0,0',
  afraid: '0,0,0,1,0,0,0,0',
  disgusted: '0,0,0,0,1,0,0,0',
  melancholic: '0,0,0,0,0,1,0,0',
  surprised: '0,0,0,0,0,0,1,0',
  calm: '0,0,0,0,0,0,0,1',
  '高兴': '1,0,0,0,0,0,0,0',
  '生气': '0,1,0,0,0,0,0,0',
  '难过': '0,0,1,0,0,0,0,0',
  '害怕': '0,0,0,1,0,0,0,0',
  '嫌弃': '0,0,0,0,1,0,0,0',
  '没劲': '0,0,0,0,0,1,0,0',
  '惊讶': '0,0,0,0,0,0,1,0',
  '平静': '0,0,0,0,0,0,0,1',
}

/** 情绪名 → 八维向量；也接受已经写好的 "0,0,...,1" 逗号串。非法值返回 undefined。 */
export function emotionVector(emotion: unknown): string | undefined {
  const raw = String(emotion ?? '').trim()
  if (raw === '') return EMOTIONS.calm
  if (/^[0-9.]+\s*(,\s*[0-9.]+\s*){7}$/.test(raw)) return raw.replace(/\s+/g, '')
  return EMOTIONS[raw.toLowerCase()] ?? EMOTIONS[raw]
}

/** 显存队列：TTS 一次合成吃满显存，且和唱歌的 Seed-VC 共用一个 GPU，统一走 gpu.js 排队。 */
let pending = 0
const MAX_PENDING = 2

/** 合成一段语音到临时 wav，返回绝对路径；失败/超时返回 null（不抛）。 */
export function synthesizeToWav(text: string, config: Config, log: Log): Promise<string | null> {
  if (config.ttsEnabled === false) return Promise.resolve(null)
  if (pending >= MAX_PENDING) {
    log('warn', 'TTS 排队已满（' + pending + ' 条），跳过: ' + text.slice(0, 20))
    return Promise.resolve(null)
  }
  pending += 1
  return withGpu(() => synthesizeOnce(text, config, log)).finally(() => { pending -= 1 })
}

async function synthesizeOnce(text: string, config: Config, log: Log): Promise<string | null> {
  const emo = emotionVector(config.ttsEmotion)
  if (emo === undefined) {
    log('warn', 'TTS 情绪值不认识: ' + String(config.ttsEmotion))
    return null
  }
  const url = String(config.ttsServerUrl ?? '').replace(/\/+$/, '')
  const query = new URLSearchParams({
    text,
    voice: String(config.ttsVoiceRef ?? ''),
    lang: 'ZH',
    emo,
    alpha: '0.6',
    speed: String(config.ttsSpeed ?? 1.0),
  })
  const timeoutMs = Number(config.ttsTimeoutMs ?? 30000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url + '/tts?' + query.toString(), { signal: controller.signal })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 44 || buffer.subarray(0, 4).toString('latin1') !== 'RIFF') throw new Error('返回的不是 wav（' + buffer.length + ' 字节）')
    const dir = await ensureTempDir()
    const wav = join(dir, 'tts-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.wav')
    await writeFile(wav, buffer)
    log('debug', 'TTS 合成: ' + text.slice(0, 20) + ' → ' + wav)
    return wav
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('warn', 'TTS 合成失败（' + message + '）: ' + text.slice(0, 20))
    return null
  } finally {
    clearTimeout(timer)
  }
}
