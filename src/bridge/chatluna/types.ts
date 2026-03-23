import type { Config } from '../../shared/config'

export interface ChatLunaHumanMessageLike {
  content?: unknown
}

export interface ChatLunaPromptVariablesLike {
  [key: string]: unknown
}

export interface ChatLunaSessionLike {
  userId?: string
  username?: string
  platform?: string
  channelId?: string
  guildId?: string
  conversationId?: string
  conversation_id?: string
  roomId?: string
  room_id?: string
  content?: string
  quote?: {
    elements?: any[]
    content?: unknown
  }
  send?(content: string | unknown): Promise<unknown> | unknown
  [key: string]: unknown
}

export type ChatLunaConfigAccessor = () => Config
