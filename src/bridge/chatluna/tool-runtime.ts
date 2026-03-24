import { h } from 'koishi'
import { AI_GENERATOR_TOOL_DEFINITIONS } from '../../shared/chatluna-tool-definitions'
import type { AiGeneratorService } from '../../service/AiGeneratorService'
import type { ImageRequestContext, StyleConfig, StyleMatchCandidate } from '../../shared/types'
import type { StructuredToolConstructor } from './runtime'
import type { ChatLunaConfigAccessor, ChatLunaSessionLike } from './types'

export function createChatLunaToolInstance(
  StructuredTool: StructuredToolConstructor,
  definition: typeof AI_GENERATOR_TOOL_DEFINITIONS[number],
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return new class extends StructuredTool {
    name = definition.name
    description = [
      definition.description,
      `Usage: ${definition.usage}`,
      `Risk: ${definition.riskLevel}`,
      `Input JSON schema: ${JSON.stringify(definition.inputSchema)}`,
    ].join('\n')
    schema = definition.inputSchema

    constructor() {
      super({ verboseParsingErrors: true })
    }

    async _call(
      input: Record<string, unknown>,
      _runManager?: unknown,
      runtimeConfig?: { configurable?: { session?: ChatLunaSessionLike } },
    ) {
      const session = runtimeConfig?.configurable?.session
      if (!session?.userId) {
        return formatToolError('会话无效，无法识别用户。')
      }

      try {
        switch (definition.name) {
          case 'aigc_generate_image':
            return await runGenerateImageTool(input, session, aiGenerator, getConfig)
          case 'aigc_edit_image':
            return await runEditImageTool(input, session, aiGenerator, getConfig)
          case 'aigc_apply_style_preset':
            return await runStylePresetTool(input, session, aiGenerator, getConfig)
          case 'aigc_get_quota':
            return formatToolJson(await aiGenerator.getQuotaSummary(
              session.userId,
              session.username || session.userId,
            ))
          case 'aigc_list_styles':
            return formatToolJson({
              items: aiGenerator.listStylePresets().map(style => ({
                commandName: style.commandName,
                description: style.description || '',
                groupName: style.groupName || '',
                aliases: style.aliases || [],
                keywords: style.keywords || [],
                examples: style.examples || [],
                category: style.category || '',
                whenToUse: style.whenToUse || '',
              })),
            })
          default:
            return formatToolError(`unsupported tool: ${definition.name}`)
        }
      } catch (error) {
        return formatToolError(error instanceof Error ? error.message : String(error))
      }
    }
  }()
}

async function runGenerateImageTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return withImageTaskLock(session, aiGenerator, async () => {
    const prompt = expectString(input.prompt, 'prompt')
    const config = getConfig()
    const requestContext = buildRequestContext(input, config)
    const numImages = requestContext.numImages || config.defaultNumImages

    const limitCheck = await aiGenerator.checkAndReserveQuota(
      session.userId!,
      session.username || session.userId!,
      numImages,
      session.platform,
    )
    if (!limitCheck.allowed) {
      return formatToolError(limitCheck.message || '额度不足。')
    }

    const images = await aiGenerator.requestProviderImages(prompt, [], numImages, requestContext)
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: 'aigc_generate_image',
    })
    const usage = await aiGenerator.recordUsage(
      session.userId!,
      session.username || session.userId!,
      'aigc_generate_image',
      images.length,
      session.platform,
    )

    return formatToolJson({ ok: true, imagesCount: images.length, images, usage })
  })
}

async function runEditImageTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return withImageTaskLock(session, aiGenerator, async () => {
    const prompt = expectString(input.prompt, 'prompt')
    const referenceMode = expectString(input.referenceMode, 'referenceMode')
    const conversationId = resolveSessionConversationId(session, aiGenerator)
    const imageUrls = resolveReferenceImages(referenceMode, input, session, aiGenerator)
    if (!imageUrls.length) {
      return formatToolError('未能解析到参考图片。')
    }

    const config = getConfig()
    const requestContext = buildRequestContext(input, config)
    const numImages = requestContext.numImages || config.defaultNumImages

    const limitCheck = await aiGenerator.checkAndReserveQuota(
      session.userId!,
      session.username || session.userId!,
      numImages,
      session.platform,
    )
    if (!limitCheck.allowed) {
      return formatToolError(limitCheck.message || '额度不足。')
    }

    const images = await aiGenerator.requestProviderImages(prompt, imageUrls, numImages, requestContext)
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      conversationId,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: 'aigc_edit_image',
      parentRecordId: referenceMode === 'last_generated' && conversationId
        ? aiGenerator.getConversationImageContext(conversationId)?.lastGenerated?.id
        : undefined,
    })
    const usage = await aiGenerator.recordUsage(
      session.userId!,
      session.username || session.userId!,
      'aigc_edit_image',
      images.length,
      session.platform,
    )

    return formatToolJson({ ok: true, imagesCount: images.length, images, referenceMode, usage })
  })
}

async function runStylePresetTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return withImageTaskLock(session, aiGenerator, async () => {
    const resolvedStyle = resolveRequestedStylePreset(input, aiGenerator)
    if ('error' in resolvedStyle) {
      return formatToolError(resolvedStyle.error)
    }
    const { preset, matches } = resolvedStyle

    const promptAdditions = typeof input.promptAdditions === 'string' ? input.promptAdditions.trim() : ''
    const prompt = [preset.prompt, promptAdditions].filter(Boolean).join(' - ')
    const referenceMode = typeof input.referenceMode === 'string' ? input.referenceMode : 'none'
    const imageUrls = referenceMode === 'none'
      ? []
      : resolveReferenceImages(referenceMode, input, session, aiGenerator)

    if (referenceMode !== 'none' && !imageUrls.length) {
      return formatToolError('未能解析到参考图片。')
    }

    const config = getConfig()
    const requestContext = buildRequestContext(input, config)
    const numImages = requestContext.numImages || config.defaultNumImages

    const limitCheck = await aiGenerator.checkAndReserveQuota(
      session.userId!,
      session.username || session.userId!,
      numImages,
      session.platform,
    )
    if (!limitCheck.allowed) {
      return formatToolError(limitCheck.message || '额度不足。')
    }

    const images = await aiGenerator.requestProviderImages(prompt, imageUrls, numImages, requestContext)
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: preset.commandName,
    })
    const usage = await aiGenerator.recordUsage(
      session.userId!,
      session.username || session.userId!,
      preset.commandName,
      images.length,
      session.platform,
    )

    return formatToolJson({
      ok: true,
      stylePreset: preset.commandName,
      imagesCount: images.length,
      images,
      usage,
      styleMatches: matches.map(item => ({
        commandName: item.style.commandName,
        score: item.score,
        matchedTerms: item.matchedTerms,
      })),
    })
  })
}

function resolveRequestedStylePreset(
  input: Record<string, unknown>,
  aiGenerator: AiGeneratorService,
): { preset: StyleConfig, matches: StyleMatchCandidate[] } | { error: string } {
  const explicitStylePreset = typeof input.stylePreset === 'string' ? input.stylePreset.trim() : ''
  if (explicitStylePreset) {
    const preset = aiGenerator.getStylePreset(explicitStylePreset)
    if (!preset) {
      return { error: `未找到风格预设：${explicitStylePreset}` }
    }
    return { preset, matches: [{ style: preset, score: 999, matchedTerms: [explicitStylePreset] }] }
  }

  const styleQuery = typeof input.styleQuery === 'string' ? input.styleQuery.trim() : ''
  if (!styleQuery) {
    return { error: 'stylePreset 或 styleQuery 至少需要提供一个。' }
  }

  const matches = aiGenerator.matchStylePresets(styleQuery, 3)
  if (!matches.length) {
    return { error: `未找到与“${styleQuery}”匹配的风格预设。` }
  }

  return { preset: matches[0].style, matches }
}

function buildRequestContext(
  input: Record<string, unknown>,
  config: ReturnType<ChatLunaConfigAccessor>,
): ImageRequestContext {
  const requestContext: ImageRequestContext = {
    numImages: typeof input.numImages === 'number' ? input.numImages : config.defaultNumImages,
  }
  const modelSuffix = typeof input.modelSuffix === 'string' ? input.modelSuffix.trim() : ''

  if (typeof input.aspectRatio === 'string') {
    requestContext.aspectRatio = input.aspectRatio as ImageRequestContext['aspectRatio']
  }
  if (typeof input.resolution === 'string') {
    requestContext.resolution = input.resolution as ImageRequestContext['resolution']
  }
  if (modelSuffix) {
    const mapping = config.modelMappings?.find(item => item.suffix === modelSuffix)
    if (mapping?.provider) requestContext.provider = mapping.provider
    if (mapping?.modelId) requestContext.modelId = mapping.modelId
    if (mapping?.apiFormat) requestContext.apiFormat = mapping.apiFormat
  }

  return requestContext
}

function resolveReferenceImages(
  referenceMode: string,
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiGeneratorService,
) {
  if (referenceMode === 'explicit') {
    return normalizeImageUrls(Array.isArray(input.imageUrls)
      ? input.imageUrls.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    )
  }

  if (referenceMode === 'last_generated') {
    const conversationId = resolveSessionConversationId(session, aiGenerator)
    if (!conversationId) return []
    const lastGenerated = aiGenerator.getConversationImageContext(conversationId)?.lastGenerated
    return lastGenerated ? [lastGenerated.imageUrl] : []
  }

  if (referenceMode === 'current_message') {
    return parseImagesFromMessageContent(session.content)
  }

  if (referenceMode === 'quoted_message') {
    return normalizeImageUrls([
      ...parseImagesFromMessageContent(session.quote?.content),
      ...(Array.isArray(session.quote?.elements)
        ? h.select(session.quote.elements, 'img').map((img: any) => img.attrs?.src)
        : []),
    ])
  }

  return []
}

function parseImagesFromMessageContent(content: unknown) {
  if (typeof content === 'string' && content.trim()) {
    return normalizeImageUrls(
      h.select(h.parse(content), 'img').map((img: any) => img.attrs?.src),
    )
  }

  if (Array.isArray(content)) {
    return normalizeImageUrls(
      h.select(content as any[], 'img').map((img: any) => img.attrs?.src),
    )
  }

  return []
}

async function sendGeneratedImages(session: ChatLunaSessionLike, images: string[]) {
  if (typeof session.send !== 'function') return
  for (const imageUrl of images) {
    await Promise.resolve(session.send(h.image(imageUrl)))
  }
}

function expectString(value: unknown, key: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required.`)
  }
  return value.trim()
}

function formatToolError(message: string) {
  return formatToolJson({ ok: false, error: message })
}

function formatToolJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function normalizeImageUrls(items: unknown[]) {
  return items
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

function resolveSessionConversationId(session: ChatLunaSessionLike, aiGenerator: AiGeneratorService) {
  return aiGenerator.buildSessionConversationId(session as any)
}

async function withImageTaskLock(
  session: ChatLunaSessionLike,
  aiGenerator: AiGeneratorService,
  work: () => Promise<string>,
) {
  const userId = session.userId
  if (!userId) {
    return formatToolError('会话无效，无法识别用户。')
  }

  if (!aiGenerator.userManager.startTask(userId)) {
    return formatToolError('您有一个图像处理任务正在进行中，请等待完成。')
  }

  try {
    return await work()
  } finally {
    aiGenerator.userManager.endTask(userId)
  }
}

// 为用户配置的 style 创建独立的 ChatLuna 工具实例
export function createStylePresetToolInstance(
  StructuredTool: StructuredToolConstructor,
  style: StyleConfig,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  const toolName = `aigc_style_${sanitizeToolName(style.commandName)}`
  const description = style.description || `Apply ${style.commandName} style to image generation`
  const metadataLines = [
    style.category ? `Category: ${style.category}` : '',
    style.whenToUse ? `When to use: ${style.whenToUse}` : '',
    style.aliases?.length ? `Aliases: ${style.aliases.join(', ')}` : '',
    style.keywords?.length ? `Keywords: ${style.keywords.join(', ')}` : '',
    style.examples?.length ? `Examples: ${style.examples.join(' | ')}` : '',
  ].filter(Boolean)

  return new class extends StructuredTool {
    name = toolName
    description = [
      description,
      ...metadataLines,
      `Usage: Use this when the user wants to apply the "${style.commandName}" style to generate or edit images.`,
      `Risk: low`,
      `Input JSON schema: {"type":"object","properties":{"promptAdditions":{"type":"string","description":"Optional extra prompt details."},"referenceMode":{"type":"string","enum":["none","current_message","quoted_message","explicit","last_generated"],"description":"Where to load reference images from."},"imageUrls":{"type":"array","items":{"type":"string"},"description":"Explicit image URLs when referenceMode is explicit."},"numImages":{"type":"number","minimum":1,"maximum":4},"aspectRatio":{"type":"string","enum":["1:1","4:3","16:9","9:16","3:2","2:3"]},"resolution":{"type":"string","enum":["1k","2k","4k"]},"modelSuffix":{"type":"string"}},"additionalProperties":false}`,
    ].join('\n')
    schema = {
      type: 'object',
      properties: {
        promptAdditions: { type: 'string', description: 'Optional extra prompt details.' },
        referenceMode: {
          type: 'string',
          enum: ['none', 'current_message', 'quoted_message', 'explicit', 'last_generated'],
          description: 'Where to load reference images from.',
        },
        imageUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit image URLs when referenceMode is explicit.',
        },
        numImages: { type: 'number', minimum: 1, maximum: 4 },
        aspectRatio: { type: 'string', enum: ['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'] },
        resolution: { type: 'string', enum: ['1k', '2k', '4k'] },
        modelSuffix: { type: 'string', description: 'Optional configured model suffix.' },
      },
      additionalProperties: false,
    }

    constructor() {
      super({ verboseParsingErrors: true })
    }

    async _call(
      input: Record<string, unknown>,
      _runManager?: unknown,
      runtimeConfig?: { configurable?: { session?: ChatLunaSessionLike } },
    ) {
      const session = runtimeConfig?.configurable?.session
      if (!session?.userId) {
        return formatToolError('会话无效，无法识别用户。')
      }

      try {
        return await runDynamicStyleTool(input, session, style, aiGenerator, getConfig)
      } catch (error) {
        return formatToolError(error instanceof Error ? error.message : String(error))
      }
    }
  }()
}

async function runDynamicStyleTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  style: StyleConfig,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return withImageTaskLock(session, aiGenerator, async () => {
    const promptAdditions = typeof input.promptAdditions === 'string' ? input.promptAdditions.trim() : ''
    const prompt = [style.prompt, promptAdditions].filter(Boolean).join(' - ')
    const referenceMode = typeof input.referenceMode === 'string' ? input.referenceMode : 'none'
    const imageUrls = referenceMode === 'none'
      ? []
      : resolveReferenceImages(referenceMode, input, session, aiGenerator)

    if (referenceMode !== 'none' && !imageUrls.length) {
      return formatToolError('未能解析到参考图片。')
    }

    const config = getConfig()
    const requestContext = buildRequestContext(input, config)
    const numImages = requestContext.numImages || config.defaultNumImages

    const limitCheck = await aiGenerator.checkAndReserveQuota(
      session.userId!,
      session.username || session.userId!,
      numImages,
      session.platform,
    )
    if (!limitCheck.allowed) {
      return formatToolError(limitCheck.message || '额度不足。')
    }

    const images = await aiGenerator.requestProviderImages(prompt, imageUrls, numImages, requestContext)
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: style.commandName,
    })
    const usage = await aiGenerator.recordUsage(
      session.userId!,
      session.username || session.userId!,
      style.commandName,
      images.length,
      session.platform,
    )

    return formatToolJson({ ok: true, stylePreset: style.commandName, imagesCount: images.length, images, usage })
  })
}

function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
}
