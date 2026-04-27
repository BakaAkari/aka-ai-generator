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
   * 注意：GPT Image API 只支持固定尺寸，不支持动态分辨率 (1k/2k/4k)
   */
  private getSizeFromAspectRatio(aspectRatio?: string): string {
    // yunwu/OpenAI Images API 支持的尺寸:
    // 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840, auto
    // 约束: 最长边 <= 3840px, 两边均为 16 的倍数, 宽高比 <= 3:1, 总像素 655360~8294400
    const sizeMap: Record<string, string> = {
      '1:1': '1024x1024',
      '3:2': '1536x1024',   // 横版 3:2
      '2:3': '1024x1536',   // 竖版 2:3
      '16:9': '2048x1152',  // 横版 16:9（精确比例）
      '9:16': '1152x2048',  // 竖版 9:16（精确比例）
      '4:3': '1536x1024',   // 横版（接近 4:3，API 无精确 4:3 尺寸）
    }
    return sizeMap[aspectRatio || '1:1'] || '1024x1024'
  }

  /**
   * 检查是否是自定义分辨率格式 (如 1024x2048)
   */
  private isCustomResolution(resolution?: string): boolean {
    if (!resolution) return false
    return /^\d+x\d+$/.test(resolution)
  }

  /**
   * 获取最终的 size 参数
   * 优先级：自定义分辨率 > 宽高比映射
   */
  private getSize(options?: ImageGenerationOptions): string {
    // 如果是自定义分辨率格式 (如 1024x2048)，直接使用
    if (options?.resolution && this.isCustomResolution(options.resolution)) {
      return options.resolution
    }
    // 否则根据宽高比映射
    return this.getSizeFromAspectRatio(options?.aspectRatio)
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
    
    // 获取 size 参数 (优先使用自定义分辨率)
    const size = this.getSize(options)
    
    // 提示用户：1k/2k/4k 预设分辨率不被 OpenAI Images API 支持
    if (options?.resolution && ['1k', '2k', '4k'].includes(options.resolution)) {
      logger?.info('当前模型不支持 1k/2k/4k 预设分辨率，已忽略', { 
        resolution: options.resolution,
        note: '请使用 Gemini 模型以获得预设分辨率控制，或使用自定义尺寸如 1024x2048'
      })
    }
    
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
   * 优先使用 JSON + base64 方式发送（兼容 Koishi ctx.http），
   * 若失败则回退到 FormData multipart 方式。
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
    
    // 获取 size 参数 (优先使用自定义分辨率)
    const size = this.getSize(options)

    // 下载所有输入图片（保留 base64 数据用于 JSON 方式）
    logger.debug('下载输入图片用于编辑', { imageCount: imageUrls.length, size, resolution: options?.resolution })
    const imageDataList: { data: string, mimeType: string }[] = []
    
    for (const url of imageUrls) {
      try {
        const result = await downloadImageAsBase64(
          ctx,
          url,
          this.config.apiTimeout,
          logger
        )
        imageDataList.push(result)
        logger.debug('图片下载成功', { mimeType: result.mimeType, dataLength: result.data.length })
      } catch (error) {
        logger.error('下载输入图片失败', { url, error: sanitizeError(error) })
        // 继续处理其他图片
      }
    }

    if (imageDataList.length === 0) {
      throw new Error('所有输入图片下载失败，无法进行图像编辑')
    }

    // 每次调用生成一张图片，循环调用
    for (let i = 0; i < numImages; i++) {
      try {
        logger.debug('调用 OpenAI Images 编辑 API', {
          prompt: prompt.substring(0, 100),
          model: this.config.modelId,
          inputImageCount: imageDataList.length,
          current: i + 1,
          total: numImages
        })

        let response: any

        // 优先使用 JSON + base64 data URI 方式（兼容 Koishi ctx.http）
        try {
          const imageInputs = imageDataList.map(img =>
            `data:${img.mimeType};base64,${img.data}`
          )

          const requestData: Record<string, any> = {
            model: this.config.modelId,
            prompt,
            n: 1,
            size,
            image: imageInputs.length === 1 ? imageInputs[0] : imageInputs,
          }

          logger.debug('使用 JSON + base64 方式调用编辑 API', {
            imageCount: imageInputs.length,
            model: this.config.modelId
          })

          response = await ctx.http.post(
            `${apiBase}/v1/images/edits`,
            requestData,
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.config.apiKey}`
              },
              timeout: this.config.apiTimeout * 1000
            }
          )
        } catch (jsonError: any) {
          // JSON 方式失败，回退到 FormData multipart 方式
          logger.warn('JSON 方式调用编辑 API 失败，回退到 FormData 方式', {
            error: sanitizeString(jsonError?.message || '未知错误')
          })

          const formData = new FormData()
          
          // 添加所有图片（第一张是主要编辑对象，其他作为参考）
          for (let idx = 0; idx < imageDataList.length; idx++) {
            const img = imageDataList[idx]
            const blob = base64ToBlob(img.data, img.mimeType)
            const filename = `image_${idx}.png`
            formData.append('image', blob, filename)
          }
          
          formData.append('prompt', prompt)
          formData.append('model', this.config.modelId)
          formData.append('n', '1')
          formData.append('size', size)

          response = await ctx.http.post(
            `${apiBase}/v1/images/edits`,
            formData,
            {
              headers: {
                'Authorization': `Bearer ${this.config.apiKey}`
                // Content-Type 由运行时自动设置（包含 boundary）
              },
              timeout: this.config.apiTimeout * 1000
            }
          )
        }

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
