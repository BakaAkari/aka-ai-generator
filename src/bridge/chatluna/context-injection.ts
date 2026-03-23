import type { Context } from 'koishi'
import type { AiGeneratorService } from '../../service/AiGeneratorService'
import type {
  ChatLunaConfigAccessor,
  ChatLunaHumanMessageLike,
  ChatLunaPromptVariablesLike,
  ChatLunaSessionLike,
} from './types'

type Disposer = (() => void) | undefined

export function installChatLunaContextInjection(
  ctx: Context,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
  logger: ReturnType<Context['logger']>,
) {
  const disposeBeforeChat = (ctx as Context & {
    on: (name: string, listener: (...args: unknown[]) => unknown) => Disposer
  }).on('chatluna/before-chat', async (...args: unknown[]) => {
    const config = getConfig()
    if (!config.chatlunaContextInjectionEnabled) return

    aiGenerator.pruneConversationImageContexts(config.chatlunaContextTtlSeconds)

    const [, messageArg, promptVariablesArg, conversationArg, sessionArg] = args
    const message = asHumanMessage(messageArg)
    const promptVariables = asPromptVariables(promptVariablesArg)
    const session = asSession(sessionArg)

    if (!message) return

    const text = getMessageText(message) || getSessionText(session)
    if (!text || hasAiGeneratorContextBlock(text) || !looksLikeImageFollowUp(text)) return

    const conversationId = extractConversationId(conversationArg, promptVariables, session, aiGenerator)
    if (!conversationId) return

    const context = aiGenerator.getConversationImageContext(conversationId)
    const lastGenerated = context?.lastGenerated
    if (!lastGenerated) return

    const contextBlock = [
      '[AIGC_CONTEXT]',
      `conversationId: ${conversationId}`,
      'lastGeneratedImage: available',
      `lastPrompt: ${lastGenerated.prompt}`,
      `stylePreset: ${lastGenerated.stylePreset || 'none'}`,
      'instruction: If the user asks to continue or modify the previous image, prefer aigc_edit_image with referenceMode=last_generated.',
      '[/AIGC_CONTEXT]',
    ].join('\n')

    const nextContent = prependContextBlockToMessage(text, contextBlock)
    setAugmentedMessageContent(message, message.content, contextBlock, nextContent)

    if (session) {
      session.content = text
    }

    if (promptVariables) {
      promptVariables.aiGeneratorContext = contextBlock
      promptVariables.aiGeneratorContextData = context
      promptVariables.input = nextContent
      promptVariables.userInput = text
      promptVariables.aiGeneratorReferenceRecommendation = 'last_generated'
    }

    logger.debug('aigc context injected for conversationId=%s', conversationId)
  })

  const disposeClearHistory = (ctx as Context & {
    on: (name: string, listener: (...args: unknown[]) => unknown) => Disposer
  }).on('chatluna/clear-chat-history', (...args: unknown[]) => {
    const conversationId = extractConversationId(
      args[0],
      asPromptVariables(args[1]),
      asSession(args[2]),
      aiGenerator,
    )
    if (!conversationId) return
    aiGenerator.clearConversationImageContext(conversationId)
    logger.debug('aigc image context cleared for conversationId=%s', conversationId)
  })

  return () => {
    disposeBeforeChat?.()
    disposeClearHistory?.()
  }
}

function looksLikeImageFollowUp(text: string) {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return false
  return [
    '上一张',
    '上一幅',
    '刚才那张',
    '刚才那幅',
    '继续改',
    '继续做',
    '继续生成',
    '保持',
    '同风格',
    '参考上一张',
    '基于上一张',
    '沿用上一张',
  ].some(pattern => normalized.includes(pattern))
}

function extractConversationId(
  conversationArg: unknown,
  promptVariables: ChatLunaPromptVariablesLike | null,
  session: ChatLunaSessionLike | null,
  aiGenerator: AiGeneratorService,
) {
  const direct = readConversationId(conversationArg)
    || readConversationId(promptVariables)
    || readConversationId(session)
  const platform = readPlatform(conversationArg)
    || readPlatform(promptVariables)
    || readPlatform(session)

  if (direct) {
    return aiGenerator.buildSessionConversationId({
      conversationId: direct,
      platform,
    })
  }

  return aiGenerator.buildSessionConversationId(session as any)
}

function readConversationId(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.conversationId === 'string' && record.conversationId.trim()) {
    return record.conversationId.trim()
  }
  if (typeof record.conversation_id === 'string' && record.conversation_id.trim()) {
    return record.conversation_id.trim()
  }
  if (typeof record.roomId === 'string' && record.roomId.trim()) {
    return record.roomId.trim()
  }
  if (typeof record.room_id === 'string' && record.room_id.trim()) {
    return record.room_id.trim()
  }
  return ''
}

function readPlatform(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.platform === 'string' && record.platform.trim()) {
    return record.platform.trim()
  }
  return ''
}

function asHumanMessage(input: unknown) {
  return input && typeof input === 'object'
    ? input as ChatLunaHumanMessageLike
    : null
}

function asPromptVariables(input: unknown) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as ChatLunaPromptVariablesLike
    : null
}

function asSession(input: unknown) {
  return input && typeof input === 'object'
    ? input as ChatLunaSessionLike
    : null
}

function getMessageText(message: ChatLunaHumanMessageLike) {
  return normalizeMessageContent(message.content)
}

function getSessionText(session?: ChatLunaSessionLike | null) {
  return session && typeof session.content === 'string' ? session.content : ''
}

function setMessageText(message: ChatLunaHumanMessageLike, text: string) {
  message.content = text
}

function setAugmentedMessageContent(
  message: ChatLunaHumanMessageLike,
  originalContent: unknown,
  contextBlock: string,
  fallbackText: string,
) {
  const prefix = `${contextBlock}\n\n`
  if (typeof originalContent === 'string' || originalContent == null) {
    setMessageText(message, fallbackText)
    return
  }

  if (Array.isArray(originalContent)) {
    message.content = [
      { type: 'text', text: prefix },
      ...originalContent,
    ]
    return
  }

  setMessageText(message, fallbackText)
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const texts = content.map((item) => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''

    const part = item as { text?: unknown, type?: unknown, content?: unknown }
    if (typeof part.text === 'string') return part.text
    if (part.type === 'text' && typeof part.content === 'string') return part.content
    return ''
  }).filter(Boolean)

  return texts.join('\n').trim()
}

function prependContextBlockToMessage(text: string, contextBlock: string) {
  return `${contextBlock}\n\n${text}`
}

function hasAiGeneratorContextBlock(text: string) {
  return text.includes('[AIGC_CONTEXT]')
}
