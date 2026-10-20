/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { LogLevel, OneBotConnection } from './onebot.js'
import { splitText } from './text.js'
import type { ObFriendInfo, ObGroupInfo } from './types.js'

/** 允许通过 napcat_api 透传的动作白名单（只读 + 发消息，避免模型乱调用管理类动作）。 */
const ALLOWED_ACTIONS = new Set([
  'send_msg',
  'send_private_msg',
  'send_group_msg',
  'get_login_info',
  'get_status',
  'get_version_info',
  'get_friend_list',
  'get_group_list',
  'get_group_info',
  'get_group_member_info',
  'get_group_member_list',
  'get_stranger_info',
])

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

function parseChatId(raw: string): { kind: 'private' | 'group'; id: string } {
  const match = /^(private|group):(.+)$/.exec(raw.trim())
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('chat_id 格式应为 private:<QQ号> 或 group:<群号>，收到: ' + raw)
  }
  const kind = match[1] === 'private' ? 'private' : 'group'
  return { kind, id: match[2].trim() }
}

export function registerTools(ctx: Context, conn: OneBotConnection, log: (level: LogLevel, message: string) => void): void {
  ctx.tools.register(defineTool({
    name: 'napcat_send_message',
    description: '主动给一个 QQ 会话发文本消息（不需要对方先说话）。chat_id 形如 private:123456 或 group:789012。超长文本会自动分段。',
    parameters: {
      chat_id: { type: 'string', required: true, description: '目标会话：private:<QQ号> 或 group:<群号>' },
      text: { type: 'string', required: true, description: '要发送的纯文本' },
      quote_message_id: { type: 'string', description: '可选：引用（回复）这条消息的 id' },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    execute: async args => {
      const input = args as { chat_id: string; text: string; quote_message_id?: string }
      const target = parseChatId(input.chat_id)
      const chunks = splitText(input.text, 1200)
      const ids: string[] = []
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        if (chunk === undefined) continue
        const message: Array<Record<string, unknown>> = []
        if (index === 0 && typeof input.quote_message_id === 'string' && input.quote_message_id !== '') {
          message.push({ type: 'reply', data: { id: input.quote_message_id } })
        }
        message.push({ type: 'text', data: { text: chunk } })
        const result = await conn.call<{ message_id?: number | string }>('send_msg', {
          message_type: target.kind,
          ...(target.kind === 'group' ? { group_id: target.id } : { user_id: target.id }),
          message,
        })
        if (result?.message_id !== undefined) ids.push(String(result.message_id))
      }
      log('info', '工具发送 ' + input.chat_id + ' (' + chunks.length + ' 段)')
      return '已发送 ' + chunks.length + ' 段到 ' + input.chat_id + (ids.length > 0 ? '（message_id: ' + ids.join(', ') + '）' : '')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'napcat_list_targets',
    description: '列出机器人账号的好友和群（用来确定 napcat_send_message 的 chat_id）。',
    parameters: {},
    output: textOutput(),
    isConcurrencySafe: () => true,
    execute: async () => {
      const friends = await conn.call<ObFriendInfo[]>('get_friend_list', {}).catch(() => [] as ObFriendInfo[])
      const groups = await conn.call<ObGroupInfo[]>('get_group_list', {}).catch(() => [] as ObGroupInfo[])
      const lines: string[] = []
      lines.push('好友（' + friends.length + '）：')
      for (const friend of friends.slice(0, 50)) {
        lines.push('  private:' + String(friend.user_id ?? '') + '  ' + String(friend.remark ?? friend.nickname ?? ''))
      }
      lines.push('群（' + groups.length + '）：')
      for (const group of groups.slice(0, 50)) {
        lines.push('  group:' + String(group.group_id ?? '') + '  ' + String(group.group_name ?? '') + '（' + String(group.member_count ?? '?') + ' 人）')
      }
      if (friends.length === 0 && groups.length === 0) lines.push('（没有取到任何会话；确认 NapCat 已登录且 get_friend_list/get_group_list 可用）')
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'napcat_api',
    description: '直接调用一个 OneBot 11 动作（只允许白名单内的只读动作与发送动作）。params_json 是 JSON 字符串，如 {"group_id":"789012","message":[{"type":"text","data":{"text":"hi"}}]}。',
    parameters: {
      action: { type: 'string', required: true, description: 'OneBot 动作名，如 get_group_list / send_group_msg' },
      params_json: { type: 'string', description: '动作参数（JSON 字符串，可省略）' },
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    execute: async args => {
      const input = args as { action: string; params_json?: string }
      if (!ALLOWED_ACTIONS.has(input.action)) {
        throw new Error('动作不在白名单内: ' + input.action + '（允许: ' + [...ALLOWED_ACTIONS].join(', ') + '）')
      }
      let params: Record<string, unknown> = {}
      if (typeof input.params_json === 'string' && input.params_json.trim() !== '') {
        const parsed: unknown = JSON.parse(input.params_json)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('params_json 必须是 JSON 对象')
        }
        params = parsed as Record<string, unknown>
      }
      const data = await conn.call<unknown>(input.action, params)
      return JSON.stringify(data ?? null, null, 2)
    },
  }))
}
