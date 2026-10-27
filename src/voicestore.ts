/**
 * 音色覆盖持久化：<workspacePath>/voice-presets.json，按会话 key 记预设名，格式
 * {"private:993484108":"银月","group:123456789":"原版"}。
 *
 * 内存表在 ttsvoice.ts（voiceOverrides），这里是它的读写盘。
 * 懒加载一次（首次调用读盘，读不到当空；文件损坏只 warn 不抛）。
 * 写入先写 .tmp 再 rename，保证原子性。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Config } from './config.js'
import type { LogLevel } from './onebot.js'
import { voiceOverrides } from './ttsvoice.js'

type Log = (level: LogLevel, message: string) => void

/** 文件名（与 memory 根同一个基准：workspacePath）。 */
export const VOICE_STORE_FILE = 'voice-presets.json'

/** 已经读过盘的路径；换 workspacePath 才重读。undefined = 还没加载过。 */
let loadedFrom: string | undefined

function storePath(config: Config): string {
  return join(config.workspacePath || process.cwd(), VOICE_STORE_FILE)
}

/** 确保内存表已按当前 workspacePath 读过一次盘。 */
export async function loadVoiceStore(config: Config, log?: Log): Promise<void> {
  const path = storePath(config)
  if (loadedFrom === path) return
  voiceOverrides.clear()
  loadedFrom = path
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      log?.('warn', '音色文件读取失败（按空处理）: ' + path + '：' + messageOf(error))
    }
    return
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是 JSON 对象')
    for (const [chatKey, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') voiceOverrides.set(chatKey, value.trim())
    }
  } catch (error) {
    voiceOverrides.clear()
    log?.('warn', '音色文件损坏（按空处理）: ' + path + '：' + messageOf(error))
  }
}

/** 读某个会话当前的音色（内存；调之前由 loadVoiceStore 懒加载）。 */
export function getStoredVoice(chatKey: string): string | undefined {
  return chatKey === '' ? undefined : voiceOverrides.get(chatKey)
}

/** 整表写盘：先写 .tmp 再 rename。失败只 warn（内存里已经生效）。 */
export async function saveVoiceStore(config: Config, log: Log, map: Map<string, string>): Promise<void> {
  const path = storePath(config)
  const tmp = path + '.tmp'
  const data: Record<string, string> = {}
  for (const [chatKey, name] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) data[chatKey] = name
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    await rename(tmp, path)
  } catch (error) {
    log('warn', '音色文件写入失败: ' + path + '：' + messageOf(error))
  }
}

/** 设定某个会话的音色并落盘（先懒加载，免得把别的会话覆盖冲掉）。 */
export async function setStoredVoice(config: Config, log: Log, chatKey: string, name: string): Promise<void> {
  await loadVoiceStore(config, log)
  if (chatKey !== '') voiceOverrides.set(chatKey, name)
  await saveVoiceStore(config, log, voiceOverrides)
}

/** 测试用：清内存缓存；下次 get/set 会重新读盘。 */
export function resetVoiceStore(): void {
  voiceOverrides.clear()
  loadedFrom = undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
