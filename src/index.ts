import { Context, Session } from 'koishi'
import type { ProviderType } from './providers'
import { createVideoProvider, VideoProvider } from './providers/video-index'
import { sanitizeError, sanitizeString } from './providers/utils'
import { UserManager } from './services/UserManager'
import { buildModelMappingIndex } from './utils/parser'
import { createImageGenerationHandlers } from './orchestrators/ImageGenerationOrchestrator'
import { buildCommandRegistry } from './commands/catalog'
import { registerImageCommands } from './commands/register-image-commands'
import { registerManagementCommands } from './commands/register-management-commands'
import { registerVideoCommands } from './commands/register-video-commands'
import { AiGeneratorService } from './service/AiGeneratorService'
import { UsageReporter } from './service/UsageReporter'
import { ChatLunaBridgeManager } from './bridge/chatluna/manager'
import { Config as ConfigSchema } from './shared/config'
import type { Config as PluginConfig } from './shared/config'
import { PLUGIN_NAME } from './shared/constants'
import { getPromptTimeoutMs } from './shared/prompt-timeout'
import type {
  GenerationDisplayInfo,
  ImageGenerationModifiers,
  ImageRequestContext,
} from './shared/types'

export const name = PLUGIN_NAME
export const inject = {
  optional: ['chatluna'],
} as const
export const Config = ConfigSchema

export type { Config as AiGeneratorConfig } from './shared/config'
export type {
  ApiFormat,
  ImageProvider,
  ModelMappingConfig,
  StyleConfig,
  StyleGroupConfig,
  VideoModelConfig,
  VideoStyleConfig,
} from './shared/types'

export function apply(ctx: Context, config: PluginConfig) {
  const logger = ctx.logger(PLUGIN_NAME)
  const userManager = new UserManager(ctx.baseDir, logger)
  const aiGenerator = new AiGeneratorService(ctx, config, userManager)
  const usageReporter = new UsageReporter({
    config,
    userManager,
    aiGenerator,
    logger,
    sanitizeError,
  })
  const chatLunaBridge = new ChatLunaBridgeManager(ctx, aiGenerator, config, logger)

  const modelMappingIndex = buildModelMappingIndex(config.modelMappings)

  // 创建视频 Provider 实例（如果启用）
  let videoProvider: VideoProvider | null = null
  
  if (config.enableVideoGeneration) {
    // 验证视频配置
    if (!config.videoApiKey) {
      logger.warn('视频生成功能已启用，但未配置云雾视频 API 密钥，视频功能将不可用')
    } else if (!config.singleImageVideoModel || !config.multiImageVideoModel) {
      logger.warn('视频生成功能已启用，但未配置单图或多图视频模型ID')
    } else {
      try {
        // 传入单图和多图模型ID，由 Provider 根据图片数量选择
        videoProvider = createVideoProvider({
          provider: config.videoProvider || 'yunwu',
          yunwuApiKey: config.videoApiKey,
          yunwuVideoModelId: config.singleImageVideoModel,
          yunwuVideoApiBase: config.videoApiBase,
          // 多图模型ID传给provider，供多图生成功能使用
          yunwuMultiImageModelId: config.multiImageVideoModel,
          apiTimeout: config.apiTimeout,
          logLevel: config.logLevel,
          logger,
          ctx
        })
        logger.info(`视频生成功能已启用 (单图模型: ${config.singleImageVideoModel}, 多图模型: ${config.multiImageVideoModel})`)
      } catch (error) {
        logger.error('创建视频 Provider 失败', { error: sanitizeError(error) })
        videoProvider = null
      }
    }
  }

  // 获取动态风格指令
  const styleDefinitions = aiGenerator.listStylePresets()

  const commandRegistry = buildCommandRegistry(styleDefinitions)

  // 通用输入获取函数
  async function getPromptInput(session: Session, message: string): Promise<string | null> {
    await session.send(message)
    const input = await session.prompt(getPromptTimeoutMs(config))
    return input || null
  }

  function resolveCommandGenerationSetup(
    numImages: number,
    modifiers?: ImageGenerationModifiers,
  ): { requestContext: ImageRequestContext, displayInfo: GenerationDisplayInfo } {
    return aiGenerator.buildGenerationSetup(numImages, modifiers)
  }

  function getConfiguredPrefix() {
    const globalConfig = ctx.root.config as { prefix?: string | string[] }
    const prefixConfig = globalConfig.prefix

    if (Array.isArray(prefixConfig) && prefixConfig.length > 0) {
      return prefixConfig[0] || ''
    }
    if (typeof prefixConfig === 'string') {
      return prefixConfig
    }
    return ''
  }

  function isTimeoutError(error: unknown) {
    return error instanceof Error && error.message === '命令执行超时'
  }

  function isSecurityBlockError(error: unknown) {
    if (!(error instanceof Error)) return false
    const errorMessage = error.message || ''
    return (
      errorMessage.includes('内容被安全策略拦截')
      || errorMessage.includes('内容被安全策略阻止')
      || errorMessage.includes('内容被阻止')
      || errorMessage.includes('被阻止')
      || errorMessage.includes('SAFETY')
      || errorMessage.includes('RECITATION')
    )
  }

  async function handleGenerationFailure(
    session: Session,
    error: unknown,
    numImages: number,
    timeoutMessage: string,
    failurePrefix: string,
  ) {
    if (!isTimeoutError(error) && isSecurityBlockError(error)) {
      await usageReporter.recordSecurityBlock(session, numImages)
    }

    if (isTimeoutError(error)) {
      return timeoutMessage
    }

    const safeMessage = error instanceof Error ? sanitizeString(error.message) : '未知错误'
    return `${failurePrefix}：${safeMessage}`
  }

  const {
    processComposeImageWithTimeout,
    processImageWithTimeout,
    processPresetImagesWithTimeout,
  } = createImageGenerationHandlers({
    aiGenerator,
    userManager,
    config,
    logger,
    sanitizeError,
    onRecordUserUsage: usageReporter.recordUsage.bind(usageReporter),
    onGenerationFailure: handleGenerationFailure,
  })


  registerImageCommands({
    ctx,
    config,
    logger,
    styleDefinitions,
    modelMappingIndex,
    reserveGenerationQuota: usageReporter.reserveGenerationQuota.bind(usageReporter),
    resolveCommandGenerationSetup,
    processImageWithTimeout,
    processPresetImagesWithTimeout,
    processComposeImageWithTimeout,
  })

  registerVideoCommands({
    ctx,
    config,
    logger,
    userManager,
    videoProvider,
    sanitizeString,
    sanitizeError,
    recordUserUsage: usageReporter.recordUsage.bind(usageReporter),
    getSessionUserName: usageReporter.getSessionUserName.bind(usageReporter),
  })

  registerManagementCommands({
    ctx,
    config,
    logger,
    userManager,
    commandRegistry,
    getPromptInput,
    getConfiguredPrefix,
  })

  const providerLabel = (config.provider as ProviderType) === 'gptgod'
    ? 'GPTGod'
    : (config.provider as ProviderType) === 'gemini'
      ? 'Google Gemini'
      : '云雾 Gemini 2.5 Flash Image'
  logger.info(`aka-ai-generator 插件已启动 (${providerLabel})`)

  // 等待 chatluna 服务可用后再同步
  ctx.inject(['chatluna'], async (ctx) => {
    await chatLunaBridge.sync(Boolean(config.chatlunaEnabled))
  })

  ;(ctx as Context & {
    accept?: (keys: string[], listener: (nextConfig: PluginConfig) => void, options?: { immediate?: boolean }) => void
  }).accept?.(
    ['chatlunaEnabled', 'chatlunaContextInjectionEnabled', 'chatlunaContextHistorySize', 'chatlunaContextTtlSeconds'],
    (nextConfig) => {
      aiGenerator.updateConfig(nextConfig)
      usageReporter.updateConfig(nextConfig)
      chatLunaBridge.updateConfig(nextConfig)
      // 只在 chatluna 服务可用时同步
      if ((ctx as Context & { chatluna?: unknown }).chatluna) {
        void chatLunaBridge.sync(Boolean(nextConfig.chatlunaEnabled))
      }
    },
    { immediate: true },
  )

  ctx.on('dispose', async () => {
    await chatLunaBridge.dispose()
  })
}
