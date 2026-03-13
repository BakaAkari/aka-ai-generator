import { ImageProvider, ProviderConfig } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

const GPTGOD_DEFAULT_API_URL = 'https://api.gptgod.online/v1/chat/completions'

export interface GptGodConfig extends ProviderConfig {
  apiKey: string
  modelId: string
}

const HTTP_URL_REGEX = /^https?:\/\//i
const DATA_URL_REGEX = /^data:image\//i

function isHttpImage(url: string): boolean {
  return HTTP_URL_REGEX.test(url)
}

function isDataImage(url: string): boolean {
  return DATA_URL_REGEX.test(url)
}

async function buildImageContentPart(
  ctx: any,
  url: string,
  timeout: number,
  logger: any
): Promise<{ type: 'image_url', image_url: { url: string } }> {
  if (!url) {
    throw new Error('下载图片失败，请检查图片链接是否有效')
  }

  if (isDataImage(url)) {
    return {
      type: 'image_url',
      image_url: { url }
    }
  }

  if (isHttpImage(url)) {
    return {
      type: 'image_url',
      image_url: { url }
    }
  }

  const { data, mimeType } = await downloadImageAsBase64(ctx, url, timeout, logger)
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mimeType};base64,${data}`
    }
  }
}

/**
 * 解析 GPTGod 响应，提取图片 URL
 */
function parseGptGodResponse(response: any, logger?: any): string[] {
  try {
    const images: string[] = []

    // 检查是否有直接的图片 URL 数组
    if (Array.isArray(response.images)) {
      if (logger) {
        logger.debug('从 response.images 数组提取图片', { count: response.images.length })
      }
      return response.images
    }

    // 检查是否有单个图片字段
    if (response.image && typeof response.image === 'string') {
      if (response.image.startsWith('data:') || response.image.startsWith('http')) {
        if (logger) {
          logger.debug('从 response.image 提取图片')
        }
        images.push(response.image)
        return images
      }
    }

    // 检查 choices 数组
    if (response?.choices?.length > 0) {
      const firstChoice = response.choices[0]
      const messageContent = firstChoice.message?.content
      let contentText = ''

      // 处理不同类型的 content
      if (typeof messageContent === 'string') {
        contentText = messageContent
      } else if (Array.isArray(messageContent)) {
        // 处理数组格式的 content（可能包含文本和图片）
        for (const part of messageContent) {
          if (part?.type === 'image_url' && part?.image_url?.url) {
            if (logger) {
              logger.debug('从 content 数组的 image_url 提取图片')
            }
            images.push(part.image_url.url)
          } else if (part?.type === 'text' && part?.text) {
            contentText += part.text + '\n'
          } else if (part?.text) {
            contentText += part.text + '\n'
          }
        }
      } else if (messageContent?.text) {
        contentText = messageContent.text
      }

      // 如果已经从 content 数组提取到图片，直接返回
      if (images.length > 0) {
        return images
      }

      // 从文本内容中提取图片 URL
      if (contentText) {
        // 匹配 Markdown 图片格式
        const mdImageRegex = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g
        let match
        while ((match = mdImageRegex.exec(contentText)) !== null) {
          images.push(match[1])
        }

        // 匹配纯 URL
        if (images.length === 0) {
          const urlRegex = /(https?:\/\/[^\s"')<>]+\.(?:png|jpg|jpeg|webp|gif|bmp))/gi
          let urlMatch
          while ((urlMatch = urlRegex.exec(contentText)) !== null) {
            images.push(urlMatch[1])
          }
        }

        // 如果内容本身就是 URL
        if (images.length === 0 && contentText.trim().startsWith('http')) {
          const trimmedUrl = contentText.trim().split(/\s/)[0]
          if (trimmedUrl.match(/^https?:\/\//)) {
            images.push(trimmedUrl)
          }
        }

        // 检查是否有 data: URL
        const dataUrlRegex = /(data:image\/[^;]+;base64,[^\s"')<>]+)/gi
        let dataUrlMatch
        while ((dataUrlMatch = dataUrlRegex.exec(contentText)) !== null) {
          images.push(dataUrlMatch[1])
        }
      }

      // 检查 message 中是否有其他图片相关字段
      if (images.length === 0 && firstChoice.message) {
        // 检查是否有 image_url 字段
        if (firstChoice.message.image_url) {
          if (logger) {
            logger.debug('从 message.image_url 提取图片')
          }
          images.push(firstChoice.message.image_url)
        }
        // 检查是否有 images 字段
        if (Array.isArray(firstChoice.message.images)) {
          if (logger) {
            logger.debug('从 message.images 数组提取图片', { count: firstChoice.message.images.length })
          }
          return firstChoice.message.images
        }
      }
    }

    // 检查响应根级别的其他可能字段
    if (images.length === 0) {
      // 检查 data 字段
      if (response.data) {
        if (Array.isArray(response.data)) {
          const dataImages = response.data.filter((item: any) =>
            item?.url || item?.image_url || (typeof item === 'string' && (item.startsWith('http') || item.startsWith('data:')))
          ).map((item: any) => item?.url || item?.image_url || item)
          if (dataImages.length > 0) {
            if (logger) {
              logger.debug('从 response.data 数组提取图片', { count: dataImages.length })
            }
            return dataImages
          }
        } else if (response.data.url || response.data.image_url) {
          if (logger) {
            logger.debug('从 response.data 提取图片')
          }
          images.push(response.data.url || response.data.image_url)
        }
      }

      // 检查 result 字段
      if (response.result) {
        if (Array.isArray(response.result)) {
          const resultImages = response.result.filter((item: any) =>
            item?.url || item?.image_url || (typeof item === 'string' && (item.startsWith('http') || item.startsWith('data:')))
          ).map((item: any) => item?.url || item?.image_url || item)
          if (resultImages.length > 0) {
            if (logger) {
              logger.debug('从 response.result 数组提取图片', { count: resultImages.length })
            }
            return resultImages
          }
        } else if (typeof response.result === 'string' && (response.result.startsWith('http') || response.result.startsWith('data:'))) {
          if (logger) {
            logger.debug('从 response.result 提取图片')
          }
          images.push(response.result)
        }
      }
    }

    if (images.length > 0) {
      if (logger) {
        logger.debug('成功提取图片', { count: images.length })
      }
    } else {
      if (logger) {
        logger.warn('未能从响应中提取图片', {
          responseStructure: {
            hasChoices: !!response?.choices,
            hasImages: !!response?.images,
            hasImage: !!response?.image,
            hasData: !!response?.data,
            hasResult: !!response?.result,
            keys: Object.keys(response || {})
          }
        })
      }
    }

    return images
  } catch (error) {
    logger?.error('解析响应时出错', { error: sanitizeError(error) })
    return []
  }
}

export class GptGodProvider implements ImageProvider {
  private config: GptGodConfig

  constructor(config: GptGodConfig) {
    this.config = config
  }

  async generateImages(
    prompt: string, 
    imageUrls: string | string[], 
    numImages: number,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const logger = this.config.logger
    const ctx = this.config.ctx

    if (!this.config.apiKey) {
      throw new Error('GPTGod 配置不完整，请检查 API Key')
    }

    if (this.config.logLevel === 'debug') {
      logger.debug('调用 GPTGod 图像编辑 API', { prompt, imageCount: urls.length, numImages })
    }

    // 预先构建图片内容部分（所有循环共用）
    const imageParts: any[] = []
    for (const url of urls) {
      try {
        const imagePart = await buildImageContentPart(
          ctx,
          url,
          this.config.apiTimeout,
          logger
        )
        imageParts.push(imagePart)
      } catch (error) {
        logger.error('构建图片部分失败，跳过该图片', { url, error: sanitizeError(error) })
      }
    }

    // GPTGod API 循环调用生成多张图片
    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const contentParts: any[] = [
        {
          type: 'text',
          text: prompt
        },
        ...imageParts
      ]

      const requestData = {
        model: this.config.modelId,
        stream: false,
        messages: [
          {
            role: 'user',
            content: contentParts
          }
        ]
      }

      logger.debug('调用 GPTGod 图像编辑 API', { prompt, imageCount: urls.length, numImages, current: i + 1 })

      // 重试配置
      const maxRetries = 3
      let lastError: any = null
      let success = false
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // 计算请求体大小（用于调试）
          const requestBodySize = JSON.stringify(requestData).length
          if (this.config.logLevel === 'debug') {
            logger.debug(`GPTGod API 请求 (尝试 ${attempt}/${maxRetries})`, {
              requestBodySize: `${(requestBodySize / 1024).toFixed(2)} KB`,
              imageCount: urls.length,
              current: i + 1
            })
          }

          const response = await ctx.http.post(
            GPTGOD_DEFAULT_API_URL,
            requestData,
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
              },
              timeout: this.config.apiTimeout * 1000
            }
          )

          // 检查响应中是否有错误信息
          if (response?.choices?.length > 0) {
            const firstChoice = response.choices[0]
            const messageContent = firstChoice.message?.content
            let errorMessage = ''

            // 提取错误消息
            if (typeof messageContent === 'string') {
              errorMessage = messageContent
            } else if (Array.isArray(messageContent)) {
              const textParts = messageContent
                .filter((part: any) => part?.type === 'text' && part?.text)
                .map((part: any) => part.text)
                .join(' ')
              errorMessage = textParts
            } else if (messageContent?.text) {
              errorMessage = messageContent.text
            }

            // 检查是否是内容政策错误
            if (errorMessage && (
              errorMessage.includes('PROHIBITED_CONTENT') ||
              errorMessage.includes('blocked by Google Gemini') ||
              errorMessage.includes('prohibited under official usage policies') ||
              errorMessage.toLowerCase().includes('content is prohibited')
            )) {
              logger.error('内容被 Google Gemini 政策拦截', {
                errorMessage: errorMessage.substring(0, 200),
                finishReason: firstChoice.finish_reason
              })
              throw new Error('内容被安全策略拦截')
            }

            // 检查其他错误消息
            if (errorMessage && (
              errorMessage.toLowerCase().includes('error') ||
              errorMessage.toLowerCase().includes('failed') ||
              errorMessage.toLowerCase().includes('blocked')
            ) && !errorMessage.match(/https?:\/\//)) {
              // 如果错误消息中没有URL（可能是图片URL），则认为是错误
              logger.error('API 返回错误消息', {
                errorMessage: errorMessage.substring(0, 200),
                finishReason: firstChoice.finish_reason
              })
              // 提取关键错误信息
              const shortError = errorMessage.length > 50 ? errorMessage.substring(0, 50) + '...' : errorMessage
              throw new Error(`处理失败：${shortError}`)
            }
          }

          // 添加调试日志，输出响应结构（仅在debug模式下）
          if (this.config.logLevel === 'debug') {
            logger.debug('GPTGod API 响应结构', {
              hasChoices: !!response?.choices,
              choicesLength: response?.choices?.length,
              hasImages: !!response?.images,
              hasImage: !!response?.image,
              responseKeys: Object.keys(response || {}),
              firstChoiceContent: response?.choices?.[0]?.message?.content ?
                (typeof response.choices[0].message.content === 'string' ?
                  response.choices[0].message.content.substring(0, 200) :
                  JSON.stringify(response.choices[0].message.content).substring(0, 200)) :
                'none'
            })
          }

          const images = parseGptGodResponse(response, this.config.logLevel === 'debug' ? logger : null)

          // 如果一张图片都没有生成，且响应中有错误信息，抛出更明确的错误
          if (images.length === 0 && response?.choices?.[0]?.message?.content) {
            const content = response.choices[0].message.content
            const contentText = typeof content === 'string' ? content :
              (Array.isArray(content) ? content.map((p: any) => p?.text || '').join(' ') : '')

            if (contentText && !contentText.match(/https?:\/\//)) {
              // 如果内容中没有URL，可能是错误消息
              const shortError = contentText.length > 50 ? contentText.substring(0, 50) + '...' : contentText
              throw new Error(`生成失败：${shortError}`)
            }
          }

          // 流式处理：每生成一张图片就立即调用回调
          logger.debug('开始流式处理图片 (GPTGod)', { 
            imagesCount: images.length,
            hasCallback: !!onImageGenerated,
            current: i + 1,
            total: numImages
          })
          
          for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
            const imageUrl = images[imgIdx]
            const currentIndex = allImages.length // 当前图片的全局索引
            allImages.push(imageUrl)
            
            logger.debug('准备处理单张图片 (GPTGod)', {
              imgIdx,
              currentIndex,
              total: numImages,
              imageUrlType: typeof imageUrl,
              imageUrlLength: imageUrl?.length || 0,
              imageUrlPrefix: imageUrl?.substring(0, 50) || 'null'
            })
            
            // 调用回调函数，立即发送图片
            if (onImageGenerated) {
              logger.info('准备调用图片生成回调函数 (GPTGod)', { 
                hasCallback: true,
                currentIndex,
                total: numImages,
                imageUrlLength: imageUrl?.length || 0
              })
              try {
                await onImageGenerated(imageUrl, currentIndex, numImages)
                logger.info('图片生成回调函数执行成功 (GPTGod)', { 
                  currentIndex, 
                  total: numImages,
                  imageUrlLength: imageUrl?.length || 0
                })
              } catch (callbackError) {
                logger.error('图片生成回调函数执行失败 (GPTGod)', { 
                  error: sanitizeError(callbackError),
                  errorMessage: callbackError?.message,
                  errorStack: callbackError?.stack,
                  currentIndex,
                  total: numImages,
                  imageUrlLength: imageUrl?.length || 0
                })
                // 回调失败不影响继续生成
              }
            } else {
              logger.warn('图片生成回调函数未提供，跳过流式发送 (GPTGod)', { 
                currentIndex,
                total: numImages,
                imageUrlLength: imageUrl?.length || 0
              })
            }
          }
          
          logger.debug('流式处理图片完成 (GPTGod)', {
            processedCount: images.length,
            allImagesCount: allImages.length
          })
          
          logger.success('GPTGod 图像编辑 API 调用成功', { current: i + 1, total: numImages })
          success = true
          break // 成功则退出重试循环
        } catch (error: any) {
          lastError = error

          // 如果是内容策略错误或其他已明确处理的错误，直接抛出原错误（不重试）
          if (error?.message && (
            error.message.includes('内容被安全策略拦截') ||
            error.message.includes('生成失败') ||
            error.message.includes('处理失败')
          )) {
            throw error
          }

          // 检查是否是连接错误（可重试的错误）
          const isRetryableError = 
            error?.cause?.code === 'UND_ERR_SOCKET' || // Socket 错误
            error?.code === 'UND_ERR_SOCKET' ||
            error?.message?.includes('other side closed') ||
            error?.message?.includes('fetch failed') ||
            error?.message?.includes('ECONNRESET') ||
            error?.message?.includes('ETIMEDOUT') ||
            (error?.response?.status >= 500 && error?.response?.status < 600) // 5xx 服务器错误

          if (isRetryableError && attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000) // 指数退避，最多5秒
            logger.warn(`GPTGod API 调用失败，将在 ${delay}ms 后重试 (${attempt}/${maxRetries})`, {
              error: error?.message || error?.cause?.message || '连接错误',
              code: error?.code || error?.cause?.code,
              current: i + 1
            })
            await new Promise(resolve => setTimeout(resolve, delay))
            continue // 重试
          }

          // 不可重试的错误或已达到最大重试次数
          // 清理敏感信息后再记录日志
          const safeMessage = typeof error?.message === 'string' ? sanitizeString(error.message) : '未知错误'
          
          logger.error('GPTGod 图像编辑 API 调用失败', {
            message: safeMessage,
            name: error?.name,
            code: error?.code,
            status: error?.response?.status,
            statusText: error?.response?.statusText,
            data: sanitizeError(error?.response?.data),
            stack: sanitizeString(error?.stack || ''),
            cause: sanitizeError(error?.cause),
            attempt,
            maxRetries,
            current: i + 1,
            total: numImages,
            // 如果是 axios 错误，通常会有 config 和 request 信息（清理敏感信息）
            url: error?.config?.url,
            method: error?.config?.method,
            headers: sanitizeError(error?.config?.headers)
          })

          // 根据错误类型返回更明确的错误信息
          if (error?.cause?.code === 'UND_ERR_SOCKET' || error?.message?.includes('other side closed')) {
            throw new Error('图像处理失败：服务器连接中断，可能是服务器负载过高或网络不稳定，请稍后重试')
          }

          if (error?.message?.includes('fetch') && error?.message?.includes(GPTGOD_DEFAULT_API_URL)) {
            throw new Error('图像处理失败：无法连接 GPTGod API 服务器，请检查网络连接或稍后重试')
          }

          if (error?.response?.status === 413) {
            throw new Error('图像处理失败：请求体过大，请尝试使用较小的图片')
          }

          if (error?.response?.status === 429) {
            throw new Error('图像处理失败：请求过于频繁，请稍后重试')
          }

          throw new Error('图像处理API调用失败')
        }
      }

      // 如果当前循环的所有重试都失败了
      if (!success) {
        // 如果已经生成了一些图片，返回已生成的
        if (allImages.length > 0) {
          logger.warn('部分图片生成失败，返回已生成的图片', { generated: allImages.length, requested: numImages })
          break
        }
        // 否则抛出错误
        throw lastError
      }
    }

    return allImages
  }
}
