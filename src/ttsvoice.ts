/**
 * 音色预设：运行时切换 + 解析实际参考音频。
 *
 * 优先级：该会话的覆盖 > ttsVoices[ttsVoice] > ttsVoiceRef（旧配置兜底）。
 * 覆盖按会话（chatKey = private:<QQ号> / group:<群号>）隔离，私聊与各群互不影响；
 * 这里只是内存表，落盘见 voicestore.ts。
 * 「原版」必须用 original_ref.wav：服务端 legacy 名单会把 u3.wav 强制映射成银月。
 */
import type { Config } from './config.js'

const FALLBACK_VOICE_REF = 'D:/NapCat/tts/refs/user/yinyue_ref_n24.wav'

/** 按会话的运行时覆盖：chatKey → 预设名。全局唯一一份，voicestore 读写同一张表。 */
export const voiceOverrides = new Map<string, string>()

/** 设定某个会话的音色（只改内存）。 */
export function setVoiceOverride(chatKey: string, name: string): void {
  if (chatKey === '') return
  voiceOverrides.set(chatKey, name)
}

/** 某个会话当前的覆盖名（没设过是 undefined）。 */
export function getVoiceOverride(chatKey: string): string | undefined {
  return chatKey === '' ? undefined : voiceOverrides.get(chatKey)
}

/** 测试用：清覆盖；传 chatKey 只清该会话，不传清全部。 */
export function resetVoiceOverride(chatKey?: string): void {
  if (chatKey !== undefined && chatKey !== '') {
    voiceOverrides.delete(chatKey)
    return
  }
  voiceOverrides.clear()
}

/** 当前音色名：该会话覆盖命中预设优先，否则用配置的 ttsVoice。chatKey 为空时跳过覆盖。 */
export function currentVoiceName(config: Config, chatKey?: string): string {
  const override = getVoiceOverride(chatKey ?? '')
  if (override !== undefined && config.ttsVoices?.[override] !== undefined) return override
  return String(config.ttsVoice ?? '')
}

/** 合成实际用的参考音频路径：会话覆盖 > 预设 > 旧的 ttsVoiceRef。 */
export function resolveVoiceRef(config: Config, chatKey?: string): string {
  const presets = config.ttsVoices ?? {}
  const picked = presets[currentVoiceName(config, chatKey)]
  if (typeof picked === 'string' && picked.trim() !== '') return picked
  return String(config.ttsVoiceRef ?? '').trim() || FALLBACK_VOICE_REF
}
