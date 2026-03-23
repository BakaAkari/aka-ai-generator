import { h } from 'koishi'
import type { Context, Session } from 'koishi'
import type { ProviderType } from '../providers'
import type { Config } from '../shared/config'
import { COMMAND_TIMEOUT_SECONDS } from '../shared/constants'
import {
  formatPromptTimeoutError,
  getPromptTimeoutMs,
  getPromptTimeoutText,
} from '../shared/prompt-timeout'
import type { GenerationDisplayInfo, ImageRequestContext } from '../shared/types'
import type { AiGeneratorService } from '../service/AiGeneratorService'
import type { UserManager } from '../services/UserManager'
import { collectImagesFromParamAndQuote, parseMessageImagesAndText } from '../utils/input'

interface CreateImageGenerationHandlersParams {
  aiGenerator: AiGeneratorService
  userManager: UserManager
  config: Config
  logger: ReturnType<Context['logger']>
  sanitizeError: (error: unknown) => unknown
  onRecordUserUsage: (
    session: Session,
    commandName: string,
    numImages?: number,
    sendStatsImmediately?: boolean,
  ) => Promise<void>
  onGenerationFailure: (
    session: Session,
    error: unknown,
    numImages: number,
    timeoutMessage: string,
    failurePrefix: string,
  ) => Promise<string>
}

export function createImageGenerationHandlers(params: CreateImageGenerationHandlersParams) {
  const {
    aiGenerator,
    userManager,
    config,
    logger,
    sanitizeError,
    onRecordUserUsage,
    onGenerationFailure,
  } = params

  async function getInputData(
    session: Session,
    imgParam: any,
    mode: 'single' | 'multiple' | 'text',
  ): Promise<{ images: string[], text?: string } | { error: string }> {
    const collectedImages: string[] = collectImagesFromParamAndQuote(session, imgParam)
    let collectedText = ''

    if (mode === 'text') {
      if (typeof imgParam === 'string' && imgParam.trim()) {
        return { images: [], text: imgParam.trim() }
      }

      await session.send('请输入画面描述')

      const msg = await session.prompt(getPromptTimeoutMs(config))
      if (!msg) return { error: formatPromptTimeoutError(config) }

      const { images, text } = parseMessageImagesAndText(msg)
      if (images.length > 0) {
        return { error: '检测到图片，本功能仅支持文字输入' }
      }

      if (!text) {
        return { error: '未检测到描述，操作已取消' }
      }

      return { images: [], text }
    }

    if (collectedImages.length > 0) {
      if (mode === 'single' && collectedImages.length > 1) {
        return { error: '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图"命令' }
      }
      return { images: collectedImages }
    }

    const promptMsg = mode === 'single'
      ? `请在${getPromptTimeoutText(config)}内发送一张图片`
      : `请在${getPromptTimeoutText(config)}内发送图片（发送纯文字结束，至少需要2张）`
    await session.send(promptMsg)

    while (true) {
      const msg = await session.prompt(getPromptTimeoutMs(config))
      if (!msg) return { error: formatPromptTimeoutError(config) }

      const { images, text } = parseMessageImagesAndText(msg)

      if (images.length > 0) {
        for (const img of images) {
          collectedImages.push(img.attrs.src)
        }

        if (mode === 'single') {
          if (collectedImages.length > 1) {
            return { error: '本功能仅支持处理一张图片，检测到多张图片' }
          }
          if (text) collectedText = text
          break
        }

        if (text) {
          collectedText = text
          break
        }

        await session.send(`已收到 ${collectedImages.length} 张图片，继续发送或输入文字结束`)
        continue
      }

      if (text) {
        if (collectedImages.length === 0) {
          return { error: '未检测到图片，请重新发起指令并发送图片' }
        }
        collectedText = text
        break
      }
    }

    return { images: collectedImages, text: collectedText }
  }

  async function requestProviderImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    requestContext?: ImageRequestContext,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>,
  ): Promise<string[]> {
    const providerType = (requestContext?.provider || config.provider) as ProviderType

    try {
      return await aiGenerator.requestProviderImages(
        prompt,
        imageUrls,
        numImages,
        requestContext,
        onImageGenerated,
      )
    } catch (error) {
      logger.error('requestProviderImages 失败', {
        providerType,
        error: sanitizeError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async function collectComposeInput(session: Session): Promise<{ images: string[], prompt: string } | { error: string }> {
    await session.send('多张图片+描述')

    const collectedImages: string[] = []
    let prompt = ''

    while (true) {
      const msg = await session.prompt(getPromptTimeoutMs(config))
      if (!msg) {
        return { error: formatPromptTimeoutError(config, '，请重试') }
      }

      const elements = h.parse(msg)
      const images = h.select(elements, 'img')
      const textElements = h.select(elements, 'text')
      const text = textElements.map(el => el.attrs.content).join(' ').trim()

      if (images.length > 0) {
        for (const img of images) {
          collectedImages.push(img.attrs.src)
        }

        if (text) {
          prompt = text
          break
        }

        await session.send(`已收到 ${collectedImages.length} 张图片，继续发送或输入描述`)
        continue
      }

      if (text) {
        if (collectedImages.length < 2) {
          return { error: `需要至少两张图片进行合成，当前只有 ${collectedImages.length} 张图片` }
        }
        prompt = text
        break
      }

      return { error: '未检测到有效内容，操作已取消' }
    }

    if (collectedImages.length < 2) {
      return { error: '需要至少两张图片进行合成，请重新发送' }
    }

    if (!prompt) {
      return { error: '未检测到prompt描述，请重新发送' }
    }

    return { images: collectedImages, prompt }
  }

  async function executeImageGenerationCore(
    session: Session,
    styleName: string,
    finalPrompt: string,
    imageCount: number,
    imageUrlsInput: string[],
    requestContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    checkTimeout?: () => boolean,
    verboseLogs: boolean = false,
  ): Promise<string> {
    const userId = session.userId
    const providerType = (requestContext?.provider || config.provider) as ProviderType
    const providerModelId = requestContext?.modelId || (
      providerType === 'yunwu'
        ? config.yunwuModelId
        : providerType === 'gptgod'
          ? config.gptgodModelId
          : config.geminiModelId
    )

    logger.info('开始图像处理', {
      userId,
      imageUrls: imageUrlsInput,
      styleName,
      prompt: finalPrompt,
      numImages: imageCount,
      provider: providerType,
      modelId: providerModelId,
    })

    let statusMessage = `开始处理图片（${styleName}）`
    const infoParts: string[] = []

    if (displayInfo?.customAdditions?.length) {
      infoParts.push(`自定义内容：${displayInfo.customAdditions.join('；')}`)
    }

    if (displayInfo?.modelId) {
      const modelDesc = displayInfo.modelDescription || displayInfo.modelId
      infoParts.push(`使用模型：${modelDesc}`)
    }

    if (infoParts.length > 0) {
      statusMessage += `\n${infoParts.join('\n')}`
    }

    statusMessage += '...'
    await session.send(statusMessage)

    const generatedImages: string[] = []
    let creditDeducted = false

    const onImageGenerated = async (imageUrl: string, index: number, total: number) => {
      if (verboseLogs) {
        logger.info('流式回调被调用', {
          userId,
          index,
          total,
          imageUrlType: typeof imageUrl,
          imageUrlLength: imageUrl?.length || 0,
          imageUrlPrefix: imageUrl?.substring(0, 50) || 'null',
          hasImageUrl: !!imageUrl,
        })
      }

      if (checkTimeout?.()) {
        logger.error('流式回调：检测到超时', { userId, index, total })
        throw new Error('命令执行超时')
      }

      generatedImages.push(imageUrl)

      if (verboseLogs) {
        logger.debug('图片已添加到 generatedImages', {
          userId,
          currentCount: generatedImages.length,
          index,
          total,
        })
        logger.info('准备发送图片', {
          userId,
          index: index + 1,
          total,
          imageUrlLength: imageUrl?.length || 0,
        })
      }

      try {
        await session.send(h.image(imageUrl))
        if (verboseLogs) {
          logger.info('流式处理：图片已发送', { index: index + 1, total, userId })
        }
      } catch (sendError) {
        logger.error('发送图片失败', {
          userId,
          error: sanitizeError(sendError),
          errorMessage: sendError instanceof Error ? sendError.message : String(sendError),
          index: index + 1,
          total,
        })
        throw sendError
      }

      if (!creditDeducted && generatedImages.length > 0) {
        creditDeducted = true
        if (verboseLogs) {
          logger.info('准备扣除积分', { userId, totalImages: total, currentIndex: index })
        }
        try {
          await onRecordUserUsage(session, styleName, total, false)
          if (verboseLogs) {
            logger.info('流式处理：积分已扣除', {
              userId,
              totalImages: total,
              currentIndex: index,
            })
          }
        } catch (creditError) {
          logger.error('扣除积分失败', {
            userId,
            error: sanitizeError(creditError),
            totalImages: total,
          })
        }
      }

      if (total > 1 && index < total - 1) {
        if (verboseLogs) {
          logger.debug('多张图片，添加延时', { index, total })
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    if (verboseLogs) {
      logger.info('准备调用 requestProviderImages，已设置回调函数', {
        userId,
        hasCallback: true,
        imageCount,
        promptLength: finalPrompt.length,
        imageUrlsCount: Array.isArray(imageUrlsInput) ? imageUrlsInput.length : (imageUrlsInput ? 1 : 0),
      })
    }

    const images = await requestProviderImages(finalPrompt, imageUrlsInput, imageCount, requestContext, onImageGenerated)

    if (verboseLogs) {
      logger.info('requestProviderImages 返回', {
        userId,
        imagesCount: images.length,
        generatedImagesCount: generatedImages.length,
        creditDeducted,
      })
    }

    if (checkTimeout?.()) throw new Error('命令执行超时')

    if (images.length === 0) {
      return '图像处理失败：未能生成图片'
    }

    aiGenerator.rememberGeneratedImages({
      session,
      imageUrls: images,
      prompt: finalPrompt,
      requestContext,
      stylePreset: styleName,
    })

    if (!creditDeducted) {
      await onRecordUserUsage(session, styleName, images.length, false)
      logger.warn('流式处理：积分在最后扣除（异常情况）', { userId, imagesCount: images.length })
    }

    await session.send('图像处理完成！')
    return ''
  }

  async function processPresetImages(
    session: Session,
    imageUrls: string[],
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    checkTimeout?: () => boolean,
  ) {
    const userId = session.userId

    if (!userId || !userManager.startTask(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }

    try {
      const imageCount = requestContext?.numImages || config.defaultNumImages

      if (imageCount < 1 || imageCount > 4) {
        return '生成数量必须在 1-4 之间'
      }

      if (!imageUrls?.length) {
        return '未检测到输入图片，请发送两张图片'
      }

      if (checkTimeout?.()) throw new Error('命令执行超时')

      const finalPrompt = (prompt || '').trim()
      if (!finalPrompt) {
        return '未检测到有效描述，操作已取消'
      }

      if (checkTimeout?.()) throw new Error('命令执行超时')
      const result = await executeImageGenerationCore(
        session,
        styleName,
        finalPrompt,
        imageCount,
        imageUrls,
        requestContext,
        displayInfo,
        checkTimeout,
        false,
      )
      if (result) return result
    } finally {
      userManager.endTask(userId)
    }
  }

  async function processImage(
    session: Session,
    img: any,
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    mode: 'single' | 'multiple' | 'text' = 'single',
    checkTimeout?: () => boolean,
  ) {
    const userId = session.userId

    if (!userId || !userManager.startTask(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }

    try {
      const imageCount = requestContext?.numImages || config.defaultNumImages

      if (imageCount < 1 || imageCount > 4) {
        return '生成数量必须在 1-4 之间'
      }

      const inputResult = await getInputData(session, img, mode)
      if ('error' in inputResult) {
        return inputResult.error
      }

      if (checkTimeout?.()) throw new Error('命令执行超时')

      const { images: imageUrls, text: extraText } = inputResult

      let finalPrompt = prompt
      if (extraText) {
        finalPrompt += ` ${extraText}`
      }
      finalPrompt = finalPrompt.trim()

      if (!finalPrompt) {
        await session.send('请发送画面描述')

        const promptMsg = await session.prompt(getPromptTimeoutMs(config))
        if (!promptMsg) {
          return formatPromptTimeoutError(config)
        }
        const elements = h.parse(promptMsg)
        const images = h.select(elements, 'img')
        if (images.length > 0) {
          return '检测到图片，本功能仅支持文字输入'
        }
        const text = h.select(elements, 'text').map(e => e.attrs.content).join(' ').trim()
        if (text) {
          finalPrompt = text
        } else {
          return '未检测到有效文字描述，操作已取消'
        }
      }

      if (checkTimeout?.()) throw new Error('命令执行超时')
      const result = await executeImageGenerationCore(
        session,
        styleName,
        finalPrompt,
        imageCount,
        imageUrls,
        requestContext,
        displayInfo,
        checkTimeout,
        true,
      )
      if (result) return result
    } finally {
      userManager.endTask(userId)
    }
  }

  async function processImageWithTimeout(
    session: Session,
    img: any,
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    mode: 'single' | 'multiple' | 'text' = 'single',
  ) {
    const userId = session.userId
    let isTimeout = false

    return Promise.race([
      processImage(session, img, prompt, styleName, requestContext, displayInfo, mode, () => isTimeout),
      new Promise<string>((_, reject) =>
        setTimeout(() => {
          isTimeout = true
          reject(new Error('命令执行超时'))
        }, COMMAND_TIMEOUT_SECONDS * 1000),
      ),
    ]).catch(async (error) => {
      logger.error('图像处理超时或失败', { userId, error: sanitizeError(error) })
      return onGenerationFailure(
        session,
        error,
        requestContext?.numImages || config.defaultNumImages,
        '图像处理超时，请重试',
        '图像处理失败',
      )
    })
  }

  async function processPresetImagesWithTimeout(
    session: Session,
    imageUrls: string[],
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
  ) {
    const userId = session.userId
    let isTimeout = false

    return Promise.race([
      processPresetImages(session, imageUrls, prompt, styleName, requestContext, displayInfo, () => isTimeout),
      new Promise<string>((_, reject) =>
        setTimeout(() => {
          isTimeout = true
          reject(new Error('命令执行超时'))
        }, COMMAND_TIMEOUT_SECONDS * 1000),
      ),
    ]).catch(async (error) => {
      logger.error('图像处理超时或失败', { userId, error: sanitizeError(error) })
      return onGenerationFailure(
        session,
        error,
        requestContext?.numImages || config.defaultNumImages,
        '图像处理超时，请重试',
        '图像处理失败',
      )
    })
  }

  async function processComposeImageWithTimeout(params: {
    session: Session
    commandName: string
    numImages: number
    requestContext?: ImageRequestContext
    modelDescription?: string
    modelMappingSummary?: { provider?: string, modelId?: string, apiFormat?: string } | null
  }) {
    const {
      session,
      commandName,
      numImages,
      requestContext,
      modelDescription,
      modelMappingSummary,
    } = params

    const userId = session.userId
    if (!userId || !userManager.startTask(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }

    let isTimeout = false

    return Promise.race([
      (async () => {
        try {
          const inputResult = await collectComposeInput(session)
          if ('error' in inputResult) {
            return inputResult.error
          }

          const { images: collectedImages, prompt } = inputResult

          if (numImages < 1 || numImages > 4) {
            return '生成数量必须在 1-4 之间'
          }

          if (isTimeout) throw new Error('命令执行超时')

          logger.info('开始图片合成处理', {
            userId,
            imageUrls: collectedImages,
            prompt,
            numImages,
            imageCount: collectedImages.length,
            modelMapping: modelMappingSummary,
          })

          let statusMessage = `开始合成图（${collectedImages.length}张）...`
          if (modelDescription) {
            statusMessage += `\n使用模型：${modelDescription}`
          }
          statusMessage += `\nPrompt: ${prompt}`
          await session.send(statusMessage)

          const generatedImages: string[] = []
          let creditDeducted = false

          const onImageGenerated = async (imageUrl: string, index: number, total: number) => {
            logger.info('流式回调被调用 (COMPOSE_IMAGE)', {
              userId,
              index,
              total,
              imageUrlType: typeof imageUrl,
              imageUrlLength: imageUrl?.length || 0,
              imageUrlPrefix: imageUrl?.substring(0, 50) || 'null',
              hasImageUrl: !!imageUrl,
            })

            if (isTimeout) {
              logger.error('流式回调：检测到超时 (COMPOSE_IMAGE)', { userId, index, total })
              throw new Error('命令执行超时')
            }

            generatedImages.push(imageUrl)
            logger.debug('图片已添加到 generatedImages (COMPOSE_IMAGE)', {
              userId,
              currentCount: generatedImages.length,
              index,
              total,
            })

            logger.info('准备发送图片 (COMPOSE_IMAGE)', {
              userId,
              index: index + 1,
              total,
              imageUrlLength: imageUrl?.length || 0,
            })
            try {
              await session.send(h.image(imageUrl))
              logger.info('流式处理：图片已发送 (COMPOSE_IMAGE)', { index: index + 1, total, userId })
            } catch (sendError) {
              logger.error('发送图片失败 (COMPOSE_IMAGE)', {
                userId,
                error: sanitizeError(sendError),
                errorMessage: sendError instanceof Error ? sendError.message : String(sendError),
                index: index + 1,
                total,
              })
              throw sendError
            }

            if (!creditDeducted && generatedImages.length > 0) {
              creditDeducted = true
              logger.info('准备扣除积分 (COMPOSE_IMAGE)', { userId, totalImages: total, currentIndex: index })
              try {
                await onRecordUserUsage(session, commandName, total, false)
                logger.info('流式处理：积分已扣除 (COMPOSE_IMAGE)', {
                  userId,
                  totalImages: total,
                  currentIndex: index,
                })
              } catch (creditError) {
                logger.error('扣除积分失败 (COMPOSE_IMAGE)', {
                  userId,
                  error: sanitizeError(creditError),
                  totalImages: total,
                })
              }
            }

            if (total > 1 && index < total - 1) {
              logger.debug('多张图片，添加延时 (COMPOSE_IMAGE)', { index, total })
              await new Promise(resolve => setTimeout(resolve, 1000))
            }
          }

          logger.info('准备调用 requestProviderImages (COMPOSE_IMAGE)，已设置回调函数', {
            userId,
            hasCallback: true,
            imageCount: numImages,
            promptLength: prompt.length,
            collectedImagesCount: collectedImages.length,
            modelId: requestContext?.modelId || 'default',
          })

          const resultImages = await requestProviderImages(
            prompt,
            collectedImages,
            numImages,
            requestContext,
            onImageGenerated,
          )

          logger.info('requestProviderImages 返回 (COMPOSE_IMAGE)', {
            userId,
            imagesCount: resultImages.length,
            generatedImagesCount: generatedImages.length,
            creditDeducted,
          })

          if (isTimeout) throw new Error('命令执行超时')

          if (resultImages.length === 0) {
            return '图片合成失败：未能生成图片'
          }

          aiGenerator.rememberGeneratedImages({
            session,
            imageUrls: resultImages,
            prompt,
            requestContext,
            stylePreset: commandName,
          })

          if (!creditDeducted) {
            await onRecordUserUsage(session, commandName, resultImages.length, false)
            logger.warn('流式处理：积分在最后扣除（异常情况）', { userId, imagesCount: resultImages.length })
          }

          await session.send('图片合成完成！')
        } finally {
          userManager.endTask(userId)
        }
      })(),
      new Promise<string>((_, reject) =>
        setTimeout(() => {
          isTimeout = true
          reject(new Error('命令执行超时'))
        }, COMMAND_TIMEOUT_SECONDS * 1000),
      ),
    ]).catch(async (error) => {
      logger.error('图片合成超时或失败', { userId, error: sanitizeError(error) })
      return onGenerationFailure(
        session,
        error,
        numImages,
        '图片合成超时，请重试',
        '图片合成失败',
      )
    })
  }

  return {
    processComposeImageWithTimeout,
    processImageWithTimeout,
    processPresetImagesWithTimeout,
  }
}
