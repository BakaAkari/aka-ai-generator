import type { Context, Session } from 'koishi'
import { COMMANDS, STYLE_TRANSFER_PROMPT } from '../shared/constants'
import { getStyleTransferImages } from './image-input'
import { parseStyleCommandModifiers } from '../utils/parser'
import type { Config } from '../shared/config'
import type {
  ImageGenerationModifiers,
  ImageRequestContext,
  ModelMappingConfig,
  ResolvedStyleConfig,
} from '../shared/types'

interface RegisterImageCommandsParams {
  ctx: Context
  config: Config
  logger: ReturnType<Context['logger']>
  styleDefinitions: ResolvedStyleConfig[]
  modelMappingIndex: Map<string, ModelMappingConfig>
  reserveGenerationQuota: (session: Session, numImages: number) => Promise<{ allowed: boolean, message?: string }>
  resolveCommandGenerationSetup: (
    numImages: number,
    modifiers?: ImageGenerationModifiers,
  ) => {
    requestContext: ImageRequestContext
    displayInfo: {
      customAdditions?: string[]
      modelId?: string
      modelDescription?: string
    }
  }
  processImageWithTimeout: (
    session: Session,
    img: any,
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: {
      customAdditions?: string[]
      modelId?: string
      modelDescription?: string
    },
    mode?: 'single' | 'multiple' | 'text',
  ) => Promise<string>
  processPresetImagesWithTimeout: (
    session: Session,
    imageUrls: string[],
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: {
      customAdditions?: string[]
      modelId?: string
      modelDescription?: string
    },
  ) => Promise<string>
  processComposeImageWithTimeout: (params: {
    session: Session
    commandName: string
    numImages: number
    requestContext?: ImageRequestContext
    modelDescription?: string
    modelMappingSummary?: { provider?: string, modelId?: string, apiFormat?: string } | null
  }) => Promise<string>
}

export function registerImageCommands(params: RegisterImageCommandsParams) {
  const {
    ctx,
    config,
    logger,
    styleDefinitions,
    modelMappingIndex,
    reserveGenerationQuota,
    resolveCommandGenerationSetup,
    processImageWithTimeout,
    processPresetImagesWithTimeout,
    processComposeImageWithTimeout,
  } = params

  const hasStyleTransferCommand = styleDefinitions.some(style => style.commandName === COMMANDS.STYLE_TRANSFER)

  if (styleDefinitions.length > 0) {
    for (const style of styleDefinitions) {
      if (!style.commandName || !style.prompt) continue

      ctx.command(`${style.commandName} [img:text]`, style.description || '图像风格转换')
        .option('num', '-n <num:number> 生成图片数量 (1-4)')
        .option('multiple', '-m 允许多图输入')
        .action(async (argv, img) => {
          const { session, options } = argv
          if (!session?.userId) return '会话无效'

          const modifiers = parseStyleCommandModifiers(argv, img, modelMappingIndex)
          const userPromptText = (modifiers.customAdditions || []).join(' - ')
          const numImages = options?.num || config.defaultNumImages

          const limitCheck = await reserveGenerationQuota(session, numImages)
          if (!limitCheck.allowed) {
            return limitCheck.message
          }

          const mergedPrompt = [style.prompt, userPromptText].filter(Boolean).join(' - ')
          const { requestContext, displayInfo } = resolveCommandGenerationSetup(numImages, modifiers)
          const mode = options?.multiple ? 'multiple' : 'single'

          return processImageWithTimeout(
            session,
            img,
            mergedPrompt,
            style.commandName,
            requestContext,
            displayInfo,
            mode,
          )
        })

      logger.info(`已注册命令: ${style.commandName}`)
    }
  }

  ctx.command(`${COMMANDS.TXT_TO_IMG} [prompt:text]`, '根据文字描述生成图像')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async (argv, prompt) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'

      const numImages = options?.num || config.defaultNumImages
      const modifiers = parseStyleCommandModifiers(argv, prompt, modelMappingIndex)
      const limitCheck = await reserveGenerationQuota(session, numImages)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const { requestContext, displayInfo } = resolveCommandGenerationSetup(numImages, modifiers)
      return processImageWithTimeout(session, prompt, '', COMMANDS.TXT_TO_IMG, requestContext, displayInfo, 'text')
    })

  ctx.command(`${COMMANDS.IMG_TO_IMG} [img:text]`, '使用自定义prompt进行图像处理')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .option('multiple', '-m 允许多图输入')
    .action(async (argv, img) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'

      const numImages = options?.num || config.defaultNumImages
      const mode = options?.multiple ? 'multiple' : 'single'
      const modifiers = parseStyleCommandModifiers(argv, img, modelMappingIndex)
      const limitCheck = await reserveGenerationQuota(session, numImages)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const { requestContext, displayInfo } = resolveCommandGenerationSetup(numImages, modifiers)
      return processImageWithTimeout(session, img, '', COMMANDS.IMG_TO_IMG, requestContext, displayInfo, mode)
    })

  if (!hasStyleTransferCommand) {
    ctx.command(`${COMMANDS.STYLE_TRANSFER} [img:text]`, '将第二张图片的视觉风格迁移至第一张图片')
      .option('num', '-n <num:number> 生成图片数量 (1-4)')
      .action(async (argv, img) => {
        const { session, options } = argv
        if (!session?.userId) return '会话无效'

        const numImages = options?.num || config.defaultNumImages
        const modifiers = parseStyleCommandModifiers(argv, img, modelMappingIndex)
        const limitCheck = await reserveGenerationQuota(session, numImages)
        if (!limitCheck.allowed) {
          return limitCheck.message
        }

        const inputResult = await getStyleTransferImages(session, config, img)
        if ('error' in inputResult) {
          return inputResult.error
        }

        const { requestContext, displayInfo } = resolveCommandGenerationSetup(numImages, modifiers)
        return processPresetImagesWithTimeout(
          session,
          inputResult.images,
          STYLE_TRANSFER_PROMPT,
          COMMANDS.STYLE_TRANSFER,
          requestContext,
          displayInfo,
        )
      })
  }

  ctx.command(COMMANDS.COMPOSE_IMAGE, '合成多张图片，使用自定义prompt控制合成效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async (argv) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'

      const modifiers = parseStyleCommandModifiers(argv, undefined, modelMappingIndex)
      const imageCount = options?.num || config.defaultNumImages
      const limitCheck = await reserveGenerationQuota(session, imageCount)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const { requestContext, displayInfo } = resolveCommandGenerationSetup(imageCount, modifiers)
      return processComposeImageWithTimeout({
        session,
        commandName: COMMANDS.COMPOSE_IMAGE,
        numImages: imageCount,
        requestContext,
        modelDescription: displayInfo.modelDescription || displayInfo.modelId,
        modelMappingSummary: modifiers.modelMapping
          ? {
              provider: modifiers.modelMapping.provider,
              modelId: modifiers.modelMapping.modelId,
              apiFormat: modifiers.modelMapping.apiFormat,
            }
          : null,
      })
    })
}
