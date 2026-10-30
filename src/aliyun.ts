/**
 * 阿里云百炼（DashScope）云端语音：识别用 qwen3-asr-flash，合成用 qwen3-tts-flash。
 *
 * 不引 SDK：两条都是普通 HTTPS POST，用原生 fetch。云端只做「听」和「嘴」的替代实现，
 * 上层（bridge 的 [语音] 回退、napcat_send_voice 的失败回退文字）完全不用改。
 * 失败一律抛错（识别）或返回 null（合成），不自动降级去拉本机 whisper / IndexTTS。
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from './config.js'
import { ensureTempDir } from './media.js'
import type { LogLevel } from './onebot.js'

type Log = (level: LogLevel, message: string) => void

/** 测试注入点：默认用全局 fetch。 */
export interface AliyunDeps {
  fetch?: typeof fetch
}

/** 官方域名；换成地域化工作空间域名时改这里的默认值即可。 */
const BASE_URL = 'https://dashscope.aliyuncs.com'
const ASR_PATH = '/compatible-mode/v1/chat/completions'
const TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
/** qwen3-tts-flash 单次文本上限（官方限制），超了不截断，直接让调用方回退文字。 */
const MAX_TTS_CHARS = 600

/** 语音 → 文本。失败抛错，由调用方回退 [语音]。 */
export async function transcribeAliyun(wav: Buffer, config: Config, log: Log, deps: AliyunDeps = {}): Promise<string> {
  const key = String(config.aliyunApiKey ?? '').trim()
  if (key === '') throw new Error('阿里云识别未配置 aliyunApiKey')
  const body = {
    model: String(config.aliyunAsrModel ?? '').trim() || 'qwen3-asr-flash',
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wav.toString('base64') } }],
    }],
    stream: false,
    asr_options: { enable_itn: false },
  }
  const json = await postJson(ASR_PATH, key, body, config.voiceTimeoutMs, deps)
  const text = String((json as AsrResponse)?.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') throw new Error('阿里云识别没有返回文字')
  log('debug', '语音转写（阿里云）: ' + text)
  return text
}

interface AsrResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  code?: unknown
  message?: unknown
}

/** 文本 → 临时 wav 路径；失败返回 null（不抛）。 */
export async function synthesizeAliyun(text: string, config: Config, log: Log, deps: AliyunDeps = {}): Promise<string | null> {
  const key = String(config.aliyunApiKey ?? '').trim()
  if (key === '') {
    log('warn', '阿里云合成未配置 aliyunApiKey，跳过: ' + text.slice(0, 20))
    return null
  }
  if (text.length > MAX_TTS_CHARS) {
    // shortcut: 一次只合成 600 字以内，超长不回退本机 TTS（这台机器没装），交给上层改发文字。
    log('warn', '云端合成单次上限 ' + MAX_TTS_CHARS + ' 字符，本次 ' + text.length + ' 字，跳过')
    return null
  }
  try {
    const json = await postJson(TTS_PATH, key, {
      model: String(config.aliyunTtsModel ?? '').trim() || 'qwen3-tts-flash',
      input: { text, voice: String(config.aliyunTtsVoice ?? '').trim() || 'Cherry', language_type: 'Chinese' },
    }, config.ttsTimeoutMs, deps)
    const audio = (json as TtsResponse)?.output?.audio
    const url = String(audio?.url ?? '').trim()
    const inline = String(audio?.data ?? '').trim()
    const buffer = url !== ''
      ? await fetchAudio(url, config.ttsTimeoutMs, deps)
      : Buffer.from(inline, 'base64')
    if (buffer.length === 0) throw new Error('云端合成没有返回音频')
    const dir = await ensureTempDir()
    const ext = buffer.subarray(0, 4).toString('latin1') === 'RIFF' ? '.wav' : '.mp3'
    const wav = join(dir, 'tts-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + ext)
    await writeFile(wav, buffer)
    log('debug', 'TTS 合成（阿里云）: ' + text.slice(0, 20) + ' → ' + wav)
    return wav
  } catch (error) {
    log('warn', '云端合成失败（' + (error instanceof Error ? error.message : String(error)) + '）: ' + text.slice(0, 20))
    return null
  }
}

interface TtsResponse {
  output?: { audio?: { url?: unknown; data?: unknown } }
  code?: unknown
  message?: unknown
}

async function postJson(path: string, key: string, body: unknown, timeoutMs: number, deps: AliyunDeps): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000)
  try {
    const response = await (deps.fetch ?? fetch)(BASE_URL + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error('HTTP ' + response.status + '：返回不是 JSON')
    }
    if (!response.ok) throw new Error('HTTP ' + response.status + '：' + describeError(json))
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function fetchAudio(url: string, timeoutMs: number, deps: AliyunDeps): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000)
  try {
    const response = await (deps.fetch ?? fetch)(url, { signal: controller.signal })
    if (!response.ok) throw new Error('下载合成音频失败 HTTP ' + response.status)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/** 百炼的错通常放在 code/message（有时还有 output.message），捞出来给日志看。 */
function describeError(json: unknown): string {
  const value = json as { code?: unknown; message?: unknown; output?: { message?: unknown } }
  const code = String(value?.code ?? '').trim()
  const message = String(value?.message ?? value?.output?.message ?? '').trim()
  if (code === '' && message === '') return '未知错误'
  return (code === '' ? '' : code + '：') + message
}
