import { ImageProvider, ProviderConfig, ImageGenerationOptions } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

export interface GrokConfig extends ProviderConfig {
  apiKey: string
  modelId: string
  apiBase?: string
}

/**
 * Grok Image API size mapping
 *
 * yunwu Grok Image creation endpoint supports:
 *   960x960, 720x1280, 1280x720, 1168x784, 784x1168
 *
 * yunwu Grok Image edit endpoint accepts aspect_ratio directly:
 *   "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "2:3" | "3:2" |
 *   "9:19.5" | "19.5:9" | "9:20" | "20:9" | "1:2" | "2:1" | "auto"
 *
 * yunwu Grok Image edit endpoint accepts resolution: "1k" | "2k"
 * yunwu Grok Image edit endpoint accepts quality: "low" | "medium" | "high"
 */

/**
 * Parse Grok Image API response (same format as OpenAI Images API)
 */
function parseGrokResponse(response: any, logger?: any): string[] {
  try {
    const images: string[] = []

    logger?.debug('parsing Grok Image API response', {
      hasResponse: !!response,
      responseType: typeof response,
      responseKeys: response ? Object.keys(response) : []
    })

    if (!response) {
      logger?.error('Grok Image API response is empty')
      return []
    }

    if (response.error) {
      const sanitizedError = sanitizeError(response.error)
      logger?.error('Grok Image API returned error', { error: sanitizedError })
      const errorMessage = response.error.message || JSON.stringify(sanitizedError)
      throw new Error(`Grok Image API error: ${sanitizeString(errorMessage)}`)
    }

    if (response.data && Array.isArray(response.data)) {
      for (const item of response.data) {
        if (item.b64_json) {
          const mimeType = 'image/jpeg'
          const dataUrl = `data:${mimeType};base64,${item.b64_json}`
          images.push(dataUrl)
          logger?.info('extracted image from response (b64_json)', {
            dataLength: item.b64_json.length,
            imageIndex: images.length - 1
          })
        } else if (item.url) {
          images.push(item.url)
          logger?.info('extracted image from response (url)', {
            url: item.url.substring(0, 50) + '...',
            imageIndex: images.length - 1
          })
        }
      }
    }

    if (images.length === 0) {
      logger?.error('no images extracted from Grok Image API response', {
        responseKeys: Object.keys(response),
        response: JSON.stringify(response).substring(0, 1000)
      })
    }

    return images
  } catch (error: any) {
    const safeMessage = sanitizeString(error?.message || 'unknown error')
    logger?.error('error parsing Grok Image response', { error: safeMessage })
    throw new Error(safeMessage)
  }
}

/**
 * Convert Base64 data to Blob (for multipart/form-data)
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

export class GrokProvider implements ImageProvider {
  private config: GrokConfig

  constructor(config: GrokConfig) {
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

    logger.debug('GrokProvider starting generation', {
      prompt: prompt.substring(0, 100),
      hasInputImages,
      inputImageCount: validUrls.length,
      numImages,
      modelId: this.config.modelId
    })

    try {
      let images: string[]

      if (hasInputImages) {
        images = await this.editImages(prompt, validUrls, numImages, options, onImageGenerated)
      } else {
        images = await this.createImages(prompt, numImages, options, onImageGenerated)
      }

      return images
    } catch (error: any) {
      logger.error('GrokProvider generation failed', {
        error: sanitizeError(error),
        hasInputImages,
        modelId: this.config.modelId
      })
      throw error
    }
  }

  /**
   * Map aspectRatio to Grok creation size.
   *
   * Grok creation endpoint only accepts fixed sizes:
   *   960x960, 720x1280, 1280x720, 1168x784, 784x1168
   */
  private getSizeFromAspectRatio(aspectRatio?: string): string {
    const sizeMap: Record<string, string> = {
      '1:1': '960x960',
      '16:9': '1280x720',
      '9:16': '720x1280',
      '3:2': '1168x784',    // closest to 3:2 (1168/784 ~ 1.49)
      '2:3': '784x1168',    // closest to 2:3
      '4:3': '1168x784',    // closest to 4:3 (no exact match)
    }
    return sizeMap[aspectRatio || '1:1'] || '960x960'
  }

  /**
   * Check if a resolution string is a custom pixel size (e.g. "960x960")
   */
  private isCustomResolution(resolution?: string): boolean {
    if (!resolution) return false
    return /^\d+x\d+$/.test(resolution)
  }

  /**
   * Get the final size parameter for the creation endpoint.
   * Priority: custom resolution > aspectRatio mapping
   */
  private getCreateSize(options?: ImageGenerationOptions): string {
    if (options?.resolution && this.isCustomResolution(options.resolution)) {
      return options.resolution
    }
    return this.getSizeFromAspectRatio(options?.aspectRatio)
  }

  /**
   * Map aspectRatio for the edit endpoint.
   *
   * Grok edit endpoint accepts aspect_ratio directly as a string:
   *   "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "2:3" | "3:2" |
   *   "9:19.5" | "19.5:9" | "9:20" | "20:9" | "1:2" | "2:1" | "auto"
   */
  private getEditAspectRatio(aspectRatio?: string): string | undefined {
    if (!aspectRatio) return undefined
    // The edit endpoint supports these ratios directly
    const validRatios = new Set([
      '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2',
      '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', 'auto'
    ])
    return validRatios.has(aspectRatio) ? aspectRatio : undefined
  }

  /**
   * Map resolution for the edit endpoint.
   * Grok edit endpoint accepts: "1k" | "2k"
   */
  private getEditResolution(resolution?: string): string | undefined {
    if (!resolution) return undefined
    if (resolution === '1k' || resolution === '2k') return resolution
    // 4k is not supported by Grok edit endpoint
    return undefined
  }

  /**
   * Text-to-image: POST /v1/images/generations
   */
  private async createImages(
    prompt: string,
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    const { logger, ctx } = this.config
    const apiBase = this.config.apiBase?.replace(/\/$/, '') || 'https://yunwu.ai'

    const allImages: string[] = []

    const size = this.getCreateSize(options)

    // Grok creation endpoint does not support 1k/2k/4k preset resolutions
    if (options?.resolution && ['1k', '2k', '4k'].includes(options.resolution)) {
      logger?.info('Grok creation endpoint does not support preset resolutions, ignored', {
        resolution: options.resolution,
        note: 'Use Grok edit endpoint or Gemini for preset resolution control'
      })
    }

    logger?.debug('Grok Image creation params', {
      size,
      aspectRatio: options?.aspectRatio,
      resolution: options?.resolution
    })

    for (let i = 0; i < numImages; i++) {
      const requestData: Record<string, any> = {
        model: this.config.modelId,
        prompt,
        size
      }

      logger.debug('calling Grok Image creation API', {
        prompt: prompt.substring(0, 100),
        model: this.config.modelId,
        size,
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

        const images = parseGrokResponse(response, this.config.logLevel === 'debug' ? logger : null)

        if (images.length === 0) {
          logger.warn('Grok Image API call succeeded but no images parsed', {
            current: i + 1,
            total: numImages
          })
          continue
        }

        for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
          const imageUrl = images[imgIdx]
          const currentIndex = allImages.length
          allImages.push(imageUrl)

          if (onImageGenerated) {
            logger.info('calling image generation callback (Grok)', {
              currentIndex,
              total: numImages
            })
            try {
              await onImageGenerated(imageUrl, currentIndex, numImages)
              logger.info('image generation callback succeeded (Grok)', { currentIndex, total: numImages })
            } catch (callbackError: any) {
              logger.error('image generation callback failed (Grok)', {
                error: sanitizeError(callbackError),
                currentIndex,
                total: numImages
              })
              throw callbackError
            }
          }
        }

        logger.success('Grok Image creation API call succeeded', { current: i + 1, total: numImages })

      } catch (error: any) {
        const safeMessage = sanitizeString(error?.message || 'unknown error')
        logger.error('Grok Image creation API call failed', {
          message: safeMessage,
          current: i + 1,
          total: numImages
        })

        if (allImages.length > 0) {
          logger.warn('partial images generated, returning available images', { generated: allImages.length, requested: numImages })
          break
        }

        throw new Error(`image generation failed: ${safeMessage}`)
      }
    }

    if (allImages.length === 0) {
      throw new Error('failed to generate any images')
    }

    return allImages
  }

  /**
   * Image editing: POST /v1/images/edits (multipart/form-data)
   *
   * Grok edit endpoint supports additional parameters:
   *   - aspect_ratio: direct ratio string
   *   - resolution: "1k" | "2k"
   *   - quality: "low" | "medium" | "high"
   *   - response_format: "b64_json" | "url"
   *   - n: number of output images (max 10)
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

    // Download input images
    logger.debug('downloading input images for editing', { imageCount: imageUrls.length })
    const imageBlobs: Blob[] = []

    // Grok edit endpoint only supports 1 input image
    const targetUrl = imageUrls[0]
    try {
      const { data, mimeType } = await downloadImageAsBase64(
        ctx,
        targetUrl,
        this.config.apiTimeout,
        logger
      )
      const blob = base64ToBlob(data, mimeType)
      imageBlobs.push(blob)
      logger.debug('image download succeeded', { mimeType, size: blob.size })
    } catch (error) {
      logger.error('failed to download input image', { url: targetUrl, error: sanitizeError(error) })
    }

    if (imageBlobs.length === 0) {
      throw new Error('failed to download input image, cannot perform image editing')
    }

    // Resolve edit-specific parameters
    const editAspectRatio = this.getEditAspectRatio(options?.aspectRatio)
    const editResolution = this.getEditResolution(options?.resolution)

    for (let i = 0; i < numImages; i++) {
      try {
        const formData = new FormData()

        formData.append('image', imageBlobs[0], 'image_0.png')
        formData.append('prompt', prompt)
        formData.append('model', this.config.modelId)
        formData.append('n', '1')

        if (editAspectRatio) {
          formData.append('aspect_ratio', editAspectRatio)
        }
        if (editResolution) {
          formData.append('resolution', editResolution)
        }

        logger.debug('calling Grok Image edit API', {
          prompt: prompt.substring(0, 100),
          model: this.config.modelId,
          aspectRatio: editAspectRatio,
          resolution: editResolution,
          current: i + 1,
          total: numImages
        })

        const response = await ctx.http.post(
          `${apiBase}/v1/images/edits`,
          formData,
          {
            headers: {
              'Authorization': `Bearer ${this.config.apiKey}`
              // Content-Type is set automatically by the runtime (includes boundary)
            },
            timeout: this.config.apiTimeout * 1000
          }
        )

        const images = parseGrokResponse(response, this.config.logLevel === 'debug' ? logger : null)

        if (images.length === 0) {
          logger.warn('Grok Image edit API call succeeded but no images parsed', {
            current: i + 1,
            total: numImages
          })
          continue
        }

        for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
          const imageUrl = images[imgIdx]
          const currentIndex = allImages.length
          allImages.push(imageUrl)

          if (onImageGenerated) {
            logger.info('calling image generation callback (Grok edit)', {
              currentIndex,
              total: numImages
            })
            try {
              await onImageGenerated(imageUrl, currentIndex, numImages)
              logger.info('image generation callback succeeded (Grok edit)', { currentIndex, total: numImages })
            } catch (callbackError: any) {
              logger.error('image generation callback failed (Grok edit)', {
                error: sanitizeError(callbackError),
                currentIndex,
                total: numImages
              })
              throw callbackError
            }
          }
        }

        logger.success('Grok Image edit API call succeeded', { current: i + 1, total: numImages })

      } catch (error: any) {
        const safeMessage = sanitizeString(error?.message || 'unknown error')
        logger.error('Grok Image edit API call failed', {
          message: safeMessage,
          current: i + 1,
          total: numImages
        })

        if (allImages.length > 0) {
          logger.warn('partial images generated, returning available images', { generated: allImages.length, requested: numImages })
          break
        }

        throw new Error(`image editing failed: ${safeMessage}`)
      }
    }

    if (allImages.length === 0) {
      throw new Error('failed to generate any images')
    }

    return allImages
  }
}
