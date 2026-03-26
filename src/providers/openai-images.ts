import { ImageProvider, ProviderConfig, ImageGenerationOptions } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

export interface OpenAIImagesConfig extends ProviderConfig {
  apiKey: string
  modelId: string
  apiBase?: string
}

/**
 * 解析 OpenAI Images API 响应
 */
function parseOpenAIImagesResponse(response: any, logger?: any): string[] {
  try {
    const images: string[] = []

    logger?.debug('开始解析 OpenAI Images API 响应', {
      hasResponse: !!response,
      responseType: typeof response,
      responseKeys: response ? Object.keys(response) : []
    })

    if (!response) {
      logger?.error('OpenAI Images API 响应为空')
      return []
    }

    // 检查错误
    if (response.error) {
      const sanitizedError = sanitizeError(response.error)
      logger?.error('OpenAI Images API 返回错误', { error: sanitizedError })
      const errorMessage = response.error.message || JSON.stringify(sanitizedError)
      throw new Error(`OpenAI Images API 错误: ${sanitizeString(errorMessage)}`)
    }

    // 检查 data 数组
    if (response.data && Array.isArray(response.data)) {
      for (const item of response.data) {
        // 支持 b64_json 格式
        if (item.b64_json) {
          const mimeType = 'image/png' // GPT Image 默认返回 PNG
          const dataUrl = `data:${mimeType};base64,${item.b64_json}`
          images.push(dataUrl)
          logger?.info('从响应中提取到图片 (b64_json)', {
            dataLength: item.b64_json.length,
            imageIndex: images.length - 1
          })
        }
        // 支持 url 格式
        else if (item.url) {
          images.push(item.url)
          logger?.info('从响应中提取到图片 (url)', {
            url: item.url.substring(0, 50) + '...',
            imageIndex: images.length - 1
          })
        }
      }
    }

    if (images.length === 0) {
      logger?.error('未能从 OpenAI Images API 响应中提取到图片', {
        responseKeys: Object.keys(response),
        response: JSON.stringify(response).substring(0, 1000)
      })
    }

    return images
  } catch (error: any) {
    const safeMessage = sanitizeString(error?.message || '未知错误')
    logger?.error('解析 OpenAI Images 响应时出错', { error: safeMessage })
    throw new Error(safeMessage)
  }
}

/**
 * 将 Base64 数据转换为 Blob（用于 multipart/form-data）
 */
function base64ToBlob(base64Data: string, mimeType: string): Blob {
  const byteCharacters = atob(base64Data)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  return new Blob([byteArray], { type: mimeType })
}

export class OpenAIImagesProvider implements ImageProvider {
  private config: OpenAIImagesConfig

  constructor(config: OpenAIImagesConfig) {
    this.config = config
  }

  async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const validUrls = urls.filter(url => url && typeof url === 'string' && url.trim())
    const hasInputImages = validUrls.length > 0

    const logger = this.config.logger
    const ctx = this.config.ctx

    logger.debug('OpenAIImagesProvider 开始生成', {
      prompt: prompt.substring(0, 100),
      hasInputImages,
      inputImageCount: validUrls.length,
      numImages,
      modelId: this.config.modelId
    })

    try {
      let images: string[]

      if (hasInputImages) {
        // 图生图：使用 /v1/images/edits，支持多张图片
        images = await this.editImages(prompt, validUrls, numImages, options, onImageGenerated)
      } else {
        // 文生图：使用 /v1/images/generations
        images = await this.createImages(prompt, numImages, options, onImageGenerated)
      }

      return images
    } catch (error: any) {
      logger.error('OpenAIImagesProvider 生成失败', {
        error: sanitizeError(error),
        hasInputImages,
        modelId: this.config.modelId
      })
      throw error
    }
  }

  /**
   * 文生图：调用 /v1/images/generations
   */
  /**
   * 根据宽高比获取 size 参数
   */
  private getSizeFromAspectRatio(aspectRatio?: string): string {
    // GPT Image 支持的尺寸
    const sizeMap: Record<string, string> = {
      '1:1': '1024x1024',
      '3:2': '1536x1024',   // 横版
      '2:3': '1024x1536',   // 竖版
      '16:9': '1536x1024',  // 横版（接近16:9）
      '9:16': '1024x1536',  // 竖版（接近9:16）
      '4:3': '1536x1024',   // 横版（接近4:3）
    }
    return sizeMap[aspectRatio || '1:1'] || '1024x1024'
  }

  private async createImages(
    prompt: string,
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    const { logger, ctx } = this.config
    const apiBase = this.config.apiBase?.replace(/\/$/, '') || 'https://yunwu.ai'

    const allImages: string[] = []
    
    // 根据宽高比确定 size
    const size = this.getSizeFromAspectRatio(options?.aspectRatio)
    
    logger?.debug('OpenAI Images 生成参数', { 
      size, 
      aspectRatio: options?.aspectRatio,
      resolution: options?.resolution 
    })

    // 每次调用生成一张图片，循环调用
    for (let i = 0; i < numImages; i++) {
      const requestData = {
        model: this.config.modelId,
        prompt,
        n: 1,
        size
      }

      logger.debug('调用 OpenAI Images 文生图 API', {
        prompt: prompt.substring(0, 100),
        model: this.config.modelId,
        current: i + 1,
        total: numImages
      })

      try {
        const response = await ctx.http.post(
          `${apiBase}/v1/images/generations`,
          requestData,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`
            },
            timeout: this.config.apiTimeout * 1000
          }
        )

        const images = parseOpenAIImagesResponse(response, this.config.logLevel === 'debug' ? logger : null)

        if (images.length === 0) {
          logger.warn('OpenAI Images API 调用成功但未解析到图片', {
            current: i + 1,
            total: numImages
          })
          continue
        }

        // 流式处理
        for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
          const imageUrl = images[imgIdx]
          const currentIndex = allImages.length
          allImages.push(imageUrl)

          if (onImageGenerated) {
            logger.info('调用图片生成回调函数 (OpenAI)', {
              currentIndex,
              total: numImages
            })
            try {
              await onImageGenerated(imageUrl, currentIndex, numImages)
              logger.info('图片生成回调函数执行成功 (OpenAI)', { currentIndex, total: numImages })
            } catch (callbackError) {
              logger.error('图片生成回调函数执行失败 (OpenAI)', {
                error: sanitizeError(callbackError),
                currentIndex,
                total: numImages
              })
              throw callbackError
            }
          }
        }

        logger.success('OpenAI Images 文生图 API 调用成功', { current: i + 1, total: numImages })

      } catch (error: any) {
        const safeMessage = sanitizeString(error?.message || '未知错误')
        logger.error('OpenAI Images 文生图 API 调用失败', {
          message: safeMessage,
          current: i + 1,
          total: numImages
        })

        // 如果已经生成了一些图片，返回已生成的
        if (allImages.length > 0) {
          logger.warn('部分图片生成失败，返回已生成的图片', { generated: allImages.length, requested: numImages })
          break
        }

        throw new Error(`图像生成失败: ${safeMessage}`)
      }
    }

    if (allImages.length === 0) {
      throw new Error('未能生成任何图片')
    }

    return allImages
  }

  /**
   * 图生图：调用 /v1/images/edits，支持多张图片输入
   */
  private async editImages(
    prompt: string,
    imageUrls: string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    const { logger, ctx } = this.config
    const apiBase = this.config.apiBase?.replace(/\/$/, '') || 'https://yunwu.ai'

    const allImages: string[] = []
    
    // 根据宽高比确定 size
    const size = this.getSizeFromAspectRatio(options?.aspectRatio)

    // 下载所有输入图片
    logger.debug('下载输入图片用于编辑', { imageCount: imageUrls.length, size })
    const imageBlobs: Blob[] = []
    
    for (const url of imageUrls) {
      try {
        const { data, mimeType } = await downloadImageAsBase64(
          ctx,
          url,
          this.config.apiTimeout,
          logger
        )
        const blob = base64ToBlob(data, mimeType)
        imageBlobs.push(blob)
        logger.debug('图片下载成功', { mimeType, size: blob.size })
      } catch (error) {
        logger.error('下载输入图片失败', { url, error: sanitizeError(error) })
        // 继续处理其他图片
      }
    }

    if (imageBlobs.length === 0) {
      throw new Error('所有输入图片下载失败，无法进行图像编辑')
    }

    // 每次调用生成一张图片，循环调用
    for (let i = 0; i < numImages; i++) {
      try {
        // 构建 FormData
        const formData = new FormData()
        
        // 添加所有图片（第一张是主要编辑对象，其他作为参考）
        for (let idx = 0; idx < imageBlobs.length; idx++) {
          const blob = imageBlobs[idx]
          const filename = `image_${idx}.png`
          formData.append('image', blob, filename)
        }
        
        formData.append('prompt', prompt)
        formData.append('model', this.config.modelId)
        formData.append('n', '1')
        formData.append('size', size)

        logger.debug('调用 OpenAI Images 编辑 API', {
          prompt: prompt.substring(0, 100),
          model: this.config.modelId,
          inputImageCount: imageBlobs.length,
          current: i + 1,
          total: numImages
        })

        const response = await ctx.http.post(
          `${apiBase}/v1/images/edits`,
          formData,
          {
            headers: {
              'Authorization': `Bearer ${this.config.apiKey}`
              // Content-Type 由浏览器/运行时自动设置（包含 boundary）
            },
            timeout: this.config.apiTimeout * 1000
          }
        )

        const images = parseOpenAIImagesResponse(response, this.config.logLevel === 'debug' ? logger : null)

        if (images.length === 0) {
          logger.warn('OpenAI Images 编辑 API 调用成功但未解析到图片', {
            current: i + 1,
            total: numImages
          })
          continue
        }

        // 流式处理
        for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
          const imageUrl = images[imgIdx]
          const currentIndex = allImages.length
          allImages.push(imageUrl)

          if (onImageGenerated) {
            logger.info('调用图片生成回调函数 (OpenAI 编辑)', {
              currentIndex,
              total: numImages
            })
            try {
              await onImageGenerated(imageUrl, currentIndex, numImages)
              logger.info('图片生成回调函数执行成功 (OpenAI 编辑)', { currentIndex, total: numImages })
            } catch (callbackError) {
              logger.error('图片生成回调函数执行失败 (OpenAI 编辑)', {
                error: sanitizeError(callbackError),
                currentIndex,
                total: numImages
              })
              throw callbackError
            }
          }
        }

        logger.success('OpenAI Images 编辑 API 调用成功', { current: i + 1, total: numImages })

      } catch (error: any) {
        const safeMessage = sanitizeString(error?.message || '未知错误')
        logger.error('OpenAI Images 编辑 API 调用失败', {
          message: safeMessage,
          current: i + 1,
          total: numImages
        })

        // 如果已经生成了一些图片，返回已生成的
        if (allImages.length > 0) {
          logger.warn('部分图片生成失败，返回已生成的图片', { generated: allImages.length, requested: numImages })
          break
        }

        throw new Error(`图像编辑失败: ${safeMessage}`)
      }
    }

    if (allImages.length === 0) {
      throw new Error('未能生成任何图片')
    }

    return allImages
  }
}
