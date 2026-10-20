/** OneBot 11 的最小类型面（只覆盖本插件用到的部分）。 */

export interface ObSegment {
  type: string
  data?: Record<string, unknown>
}

export type ObMessage = string | ObSegment[]

export interface ObSender {
  user_id?: number | string
  nickname?: string
  card?: string
}

export interface ObBaseEvent {
  time?: number
  self_id?: number | string
  post_type: string
}

export interface ObMessageEvent extends ObBaseEvent {
  post_type: 'message'
  message_type: 'private' | 'group'
  sub_type?: string
  message_id?: number | string
  message_seq?: number | string
  user_id: number | string
  group_id?: number | string
  message: ObMessage
  raw_message?: string
  sender?: ObSender
}

export interface ObMetaEvent extends ObBaseEvent {
  post_type: 'meta_event' | 'notice' | 'request'
  meta_event_type?: string
  notice_type?: string
}

export type ObEvent = ObMessageEvent | ObMetaEvent | ObBaseEvent

export interface ObActionResponse<T = unknown> {
  status?: 'ok' | 'failed' | 'async'
  retcode?: number
  data?: T
  message?: string
  wording?: string
  echo?: unknown
}

export interface SendMsgResult {
  message_id?: number | string
}

export interface ObGroupInfo {
  group_id?: number | string
  group_name?: string
  member_count?: number
}

export interface ObFriendInfo {
  user_id?: number | string
  nickname?: string
  remark?: string
}
