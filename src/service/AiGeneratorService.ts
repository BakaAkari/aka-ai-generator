import type { Context, Session } from 'koishi'
import { Service } from 'koishi'
import { createImageProvider, type ProviderType } from '../providers'
import { ImageContextStore } from '../core/image-context-store'
import type { Config } from '../shared/config'
import type {
  GeneratedImageRecord,
  GenerationDisplayInfo,
  ImageGenerationModifiers,
  ImageRequestContext,
  ResolvedStyleConfig,
  StyleConfig,
} from '../shared/types'
import { PLUGIN_NAME } from '../shared/constants'
import { UserManager } from '../services/UserManager'

declare module 'koishi' {
  interface Context {
    aiGenerator: AiGeneratorService
  }
}

export interface RememberGeneratedImagesParams {
  session?: Session | null
  conversationId?: string
  imageUrls: string[]
  prompt: string
  source?: GeneratedImageRecord['source']
  requestContext?: ImageRequestContext
  stylePreset?: string
  parentRecordId?: string
}

export interface UsageRecordingResult {
  totalUsageCount: number
  remainingPurchasedCount: number
  remainingToday?: number
  isAdmin: boolean
  isPlatformExempt: boolean
}

interface SessionConversationLike {
  conversationId?: string
  conversation_id?: string
  roomId?: string
  room_id?: string
  platform?: string
  channelId?: string
  guildId?: string
  userId?: string
}

export class AiGeneratorService extends Service {
  readonly userManager: UserManager
  readonly imageContextStore: ImageContextStore

  private pluginConfig: Config
  private readonly pluginLogger: ReturnType<Context['logger']>
  private styleDefinitions: ResolvedStyleConfig[]

  constructor(ctx: Context, config: Config, userManager: UserManager) {
    super(ctx, 'aiGenerator', true)

    this.pluginConfig = config
    this.userManager = userManager
    this.imageContextStore = new ImageContextStore()
    this.pluginLogger = ctx.logger(PLUGIN_NAME)
    this.styleDefinitions = this.collectStyleDefinitions(config)
  }

  updateConfig(config: Config) {
    this.pluginConfig = config
    this.styleDefinitions = this.collectStyleDefinitions(config)
  }

  getProviderInstance(requestContext?: ImageRequestContext) {
    const providerType = (requestContext?.provider || this.pluginConfig.provider) as ProviderType
    const targetModelId = requestContext?.modelId
    const targetApiFormat = requestContext?.apiFormat

    return createImageProvider({
      provider: providerType,
      yunwuApiKey: this.pluginConfig.yunwuApiKey,
      yunwuModelId: providerType === 'yunwu'
        ? (targetModelId || this.pluginConfig.yunwuModelId)
        : this.pluginConfig.yunwuModelId,
      yunwuApiFormat: targetApiFormat || this.pluginConfig.yunwuApiFormat || 'gemini',
      gptgodApiKey: this.pluginConfig.gptgodApiKey,
      gptgodModelId: providerType === 'gptgod'
        ? (targetModelId || this.pluginConfig.gptgodModelId)
        : this.pluginConfig.gptgodModelId,
      geminiApiKey: this.pluginConfig.geminiApiKey,
      geminiModelId: providerType === 'gemini'
        ? (targetModelId || this.pluginConfig.geminiModelId)
        : this.pluginConfig.geminiModelId,
      geminiApiBase: this.pluginConfig.geminiApiBase,
      apiTimeout: this.pluginConfig.apiTimeout,
      logLevel: this.pluginConfig.logLevel,
      logger: this.pluginLogger,
      ctx: this.ctx,
    })
  }

  async requestProviderImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    requestContext?: ImageRequestContext,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>,
  ) {
    const providerType = (requestContext?.provider || this.pluginConfig.provider) as ProviderType
    const targetModelId = requestContext?.modelId
    const imageOptions = {
      resolution: requestContext?.resolution,
      aspectRatio: requestContext?.aspectRatio,
    }

    this.pluginLogger.info('requestProviderImages 调用', {
      providerType,
      modelId: targetModelId || 'default',
      numImages,
      hasCallback: !!onImageGenerated,
      promptLength: prompt.length,
      imageUrlsCount: Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0),
      ...imageOptions,
    })

    const providerInstance = this.getProviderInstance(requestContext)
    const result = await providerInstance.generateImages(prompt, imageUrls, numImages, imageOptions, onImageGenerated)

    this.pluginLogger.info('requestProviderImages 完成', {
      providerType,
      resultCount: result.length,
    })

    return result
  }

  buildSessionConversationId(session?: SessionConversationLike | Session | null) {
    if (!session) return undefined

    const explicitConversationId = [
      (session as SessionConversationLike).conversationId,
      (session as SessionConversationLike).conversation_id,
      (session as SessionConversationLike).roomId,
      (session as SessionConversationLike).room_id,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)

    if (explicitConversationId) {
      const platformPrefix = typeof session.platform === 'string' && session.platform.trim()
        ? `${session.platform.trim()}:`
        : ''
      if (platformPrefix && explicitConversationId.startsWith(platformPrefix)) {
        return explicitConversationId.trim()
      }
      return `${platformPrefix}${explicitConversationId.trim()}`
    }

    const base = session.channelId || session.guildId || session.userId
    if (!base) return undefined

    const platformPrefix = typeof session.platform === 'string' && session.platform.trim()
      ? `${session.platform.trim()}:`
      : ''
    return `${platformPrefix}${base}`
  }

  rememberGeneratedImages(params: RememberGeneratedImagesParams) {
    const conversationId = params.conversationId || this.buildSessionConversationId(params.session)
    const userId = params.session?.userId || 'unknown'
    if (!conversationId || !params.imageUrls.length) return []

    const provider = (params.requestContext?.provider || this.pluginConfig.provider) as ProviderType
    const modelId = params.requestContext?.modelId
      || (provider === 'yunwu'
        ? this.pluginConfig.yunwuModelId
        : provider === 'gptgod'
          ? this.pluginConfig.gptgodModelId
          : this.pluginConfig.geminiModelId)

    const createdAt = Date.now()
    const records = params.imageUrls.map((imageUrl, index) => {
      const record: GeneratedImageRecord = {
        id: `${conversationId}:${createdAt}:${index}`,
        conversationId,
        userId,
        createdAt,
        source: params.source || 'generated',
        imageUrl,
        prompt: params.prompt,
        normalizedPrompt: params.prompt.trim(),
        provider,
        modelId,
        aspectRatio: params.requestContext?.aspectRatio,
        resolution: params.requestContext?.resolution,
        stylePreset: params.stylePreset,
        parentRecordId: params.parentRecordId,
      }

      this.imageContextStore.addGeneratedRecord(record, {
        maxRecordsPerConversation: this.pluginConfig.chatlunaContextHistorySize,
      })
      return record
    })

    return records
  }

  getConversationImageContext(conversationId: string) {
    return this.imageContextStore.getConversationContext(conversationId)
  }

  clearConversationImageContext(conversationId: string) {
    this.imageContextStore.clearConversation(conversationId)
  }

  pruneConversationImageContexts(ttlSeconds: number) {
    this.imageContextStore.pruneExpired(ttlSeconds * 1000)
  }

  listStylePresets() {
    return this.styleDefinitions
  }

  getStylePreset(commandName: string) {
    const normalized = commandName.trim().toLowerCase()
    return this.styleDefinitions.find(style => style.commandName.trim().toLowerCase() === normalized)
  }

  getQuotaSummary(userId: string, userName: string) {
    return this.userManager.getUserData(userId, userName).then((userData) => {
      const remainingToday = Math.max(0, this.pluginConfig.dailyFreeLimit - userData.dailyUsageCount)
      const totalAvailable = remainingToday + userData.remainingPurchasedCount
      return {
        userId,
        userName: userData.userName,
        remainingToday,
        remainingPurchasedCount: userData.remainingPurchasedCount,
        totalAvailable,
        totalUsageCount: userData.totalUsageCount,
        purchasedCount: userData.purchasedCount,
      }
    })
  }

  checkAndReserveQuota(userId: string, userName: string, numImages: number, platform?: string) {
    return this.userManager.checkAndReserveQuota(
      userId,
      userName,
      numImages,
      this.pluginConfig,
      platform,
    )
  }

  buildGenerationSetup(numImages: number, modifiers?: ImageGenerationModifiers) {
    const requestContext: ImageRequestContext = { numImages }

    if (modifiers?.modelMapping?.provider) {
      requestContext.provider = modifiers.modelMapping.provider as ProviderType
    }
    if (modifiers?.modelMapping?.modelId) {
      requestContext.modelId = modifiers.modelMapping.modelId
    }
    if (modifiers?.modelMapping?.apiFormat) {
      requestContext.apiFormat = modifiers.modelMapping.apiFormat
    }
    if (modifiers?.resolution) {
      requestContext.resolution = modifiers.resolution
    }
    if (modifiers?.aspectRatio) {
      requestContext.aspectRatio = modifiers.aspectRatio
    }

    const displayInfo: GenerationDisplayInfo = {}
    if (modifiers?.customAdditions?.length) {
      displayInfo.customAdditions = modifiers.customAdditions
    }
    if (modifiers?.modelMapping?.modelId) {
      displayInfo.modelId = modifiers.modelMapping.modelId
      displayInfo.modelDescription = modifiers.modelMapping.suffix || modifiers.modelMapping.modelId
    }

    return { requestContext, displayInfo }
  }

  async recordUsage(userId: string, userName: string, commandName: string, numImages: number, platform?: string): Promise<UsageRecordingResult> {
    const isAdmin = this.userManager.isAdmin(userId, this.pluginConfig)
    const isPlatformExempt = Boolean(platform && this.pluginConfig.unlimitedPlatforms?.includes(platform))

    if (isAdmin || isPlatformExempt) {
      const userData = await this.userManager.recordUsageOnly(userId, userName, commandName, numImages)
      return {
        totalUsageCount: userData.totalUsageCount,
        remainingPurchasedCount: userData.remainingPurchasedCount,
        remainingToday: Math.max(0, this.pluginConfig.dailyFreeLimit - userData.dailyUsageCount),
        isAdmin,
        isPlatformExempt,
      }
    }

    const result = await this.userManager.consumeQuota(userId, userName, commandName, numImages, this.pluginConfig)
    return {
      totalUsageCount: result.userData.totalUsageCount,
      remainingPurchasedCount: result.userData.remainingPurchasedCount,
      remainingToday: Math.max(0, this.pluginConfig.dailyFreeLimit - result.userData.dailyUsageCount),
      isAdmin: false,
      isPlatformExempt: false,
    }
  }

  private collectStyleDefinitions(config: Config): ResolvedStyleConfig[] {
    const unique = new Map<string, ResolvedStyleConfig>()

    const pushStyle = (style?: StyleConfig, groupName?: string) => {
      if (!style?.commandName || !style?.prompt) return
      if (unique.has(style.commandName)) {
        this.pluginLogger.warn('检测到重复的风格命令名称，已跳过', {
          commandName: style.commandName,
          groupName,
        })
        return
      }
      unique.set(style.commandName, {
        ...style,
        groupName,
      })
    }

    if (Array.isArray(config.styles)) {
      for (const style of config.styles) {
        pushStyle(style)
      }
    }

    if (config.styleGroups && typeof config.styleGroups === 'object') {
      for (const [groupName, group] of Object.entries(config.styleGroups)) {
        if (!groupName || !group || !Array.isArray(group.prompts)) continue
        for (const style of group.prompts) {
          pushStyle(style, groupName)
        }
      }
    }

    return Array.from(unique.values())
  }
}
