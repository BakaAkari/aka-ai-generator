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
    if (!text || hasAnyAiGeneratorContextBlock(text)) return

    const conversationId = extractConversationId(conversationArg, promptVariables, session, aiGenerator)
    const styleMatches = aiGenerator.matchStylePresets(text, 3)
    const shouldInjectStyleCandidates = styleMatches.length > 0
    const shouldInjectImageContext = looksLikeImageFollowUp(text) && Boolean(conversationId)

    if (!shouldInjectStyleCandidates && !shouldInjectImageContext) return

    const context = conversationId ? aiGenerator.getConversationImageContext(conversationId) : undefined
    const lastGenerated = context?.lastGenerated
    const blocks: string[] = []

    if (shouldInjectImageContext && conversationId && lastGenerated) {
      blocks.push([
        '[AIGC_CONTEXT]',
        `conversationId: ${conversationId}`,
        'lastGeneratedImage: available',
        `lastPrompt: ${lastGenerated.prompt}`,
        `stylePreset: ${lastGenerated.stylePreset || 'none'}`,
        'instruction: If the user asks to continue or modify the previous image, prefer aigc_edit_image with referenceMode=last_generated.',
        '[/AIGC_CONTEXT]',
      ].join('\n'))
    }

    if (shouldInjectStyleCandidates) {
      blocks.push(formatStyleCandidatesBlock(styleMatches))
    }

    if (!blocks.length) return

    const combinedBlock = blocks.join('\n\n')
    const nextContent = prependContextBlockToMessage(text, combinedBlock)
    setAugmentedMessageContent(message, message.content, combinedBlock, nextContent)

    if (session) {
      session.content = text
    }

    if (promptVariables) {
      promptVariables.aiGeneratorContext = combinedBlock
      promptVariables.aiGeneratorContextData = context
      promptVariables.aiGeneratorStyleCandidates = styleMatches.map(item => ({
        commandName: item.style.commandName,
        description: item.style.description || '',
        aliases: item.style.aliases || [],
        keywords: item.style.keywords || [],
        category: item.style.category || '',
        whenToUse: item.style.whenToUse || '',
        score: item.score,
        matchedTerms: item.matchedTerms,
      }))
      promptVariables.aiGeneratorPreferredStylePreset = styleMatches[0]?.style.commandName || ''
      promptVariables.input = nextContent
      promptVariables.userInput = text
      if (shouldInjectImageContext && lastGenerated) {
        promptVariables.aiGeneratorReferenceRecommendation = 'last_generated'
      }
    }

    logger.debug('aigc context injected for conversationId=%s with %s style candidates', conversationId || 'n/a', styleMatches.length)
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

function hasAnyAiGeneratorContextBlock(text: string) {
  return text.includes('[AIGC_CONTEXT]') || text.includes('[AIGC_STYLE_CANDIDATES]')
}

function formatStyleCandidatesBlock(
  matches: ReturnType<AiGeneratorService['matchStylePresets']>,
) {
  const lines = ['[AIGC_STYLE_CANDIDATES]']
  for (const [index, item] of matches.entries()) {
    lines.push(`${index + 1}. ${item.style.commandName}`)
    if (item.style.description) lines.push(`description: ${item.style.description}`)
    if (item.style.aliases?.length) lines.push(`aliases: ${item.style.aliases.join(', ')}`)
    if (item.style.keywords?.length) lines.push(`keywords: ${item.style.keywords.join(', ')}`)
    if (item.style.whenToUse) lines.push(`whenToUse: ${item.style.whenToUse}`)
    if (item.matchedTerms.length) lines.push(`matchedTerms: ${item.matchedTerms.join(', ')}`)
  }
  lines.push('instruction: If the user seems to reference one of these configured styles, prefer aigc_apply_style_preset and pass stylePreset exactly, or pass styleQuery when uncertain.')
  lines.push('[/AIGC_STYLE_CANDIDATES]')
  return lines.join('\n')
}
