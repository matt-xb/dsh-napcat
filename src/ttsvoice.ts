/**
 * 音色预设：运行时切换 + 解析实际参考音频。
 *
 * 优先级：运行时覆盖 > ttsVoices[ttsVoice] > ttsVoiceRef（旧配置兜底）。
 * 「原版」必须用 original_ref.wav：服务端 legacy 名单会把 u3.wav 强制映射成银月。
 */
import type { Config } from './config.js'

const FALLBACK_VOICE_REF = 'D:/NapCat/tts/refs/user/yinyue_ref_n24.wav'

/** 运行时切换的预设名（进程内有效；重启后回到配置的 ttsVoice）。 */
let override: string | undefined

export function setVoiceOverride(name: string): void {
  override = name
}

/** 测试用：清掉运行时覆盖。 */
export function resetVoiceOverride(): void {
  override = undefined
}

/** 当前音色名：运行时覆盖命中预设优先，否则用配置的 ttsVoice。 */
export function currentVoiceName(config: Config): string {
  if (override !== undefined && config.ttsVoices?.[override] !== undefined) return override
  return String(config.ttsVoice ?? '')
}

/** 合成实际用的参考音频路径：覆盖 > 预设 > 旧的 ttsVoiceRef。 */
export function resolveVoiceRef(config: Config): string {
  const presets = config.ttsVoices ?? {}
  const picked = presets[currentVoiceName(config)]
  if (typeof picked === 'string' && picked.trim() !== '') return picked
  return String(config.ttsVoiceRef ?? '').trim() || FALLBACK_VOICE_REF
}
