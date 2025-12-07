import { ImageProvider, ProviderConfig, sanitizeError, sanitizeString } from './types'

export interface YunwuConfig extends ProviderConfig {
  apiKey: string
  modelId: string
}

/**
 * 下载图片并转换为 Base64
 */
async function downloadImageAsBase64(
  ctx: any,
  url: string,
  timeout: number,
  logger: any
): Promise<{ data: string, mimeType: string }> {
  try {
    const response = await ctx.http.get(url, { 
      responseType: 'arraybuffer',
      timeout: timeout * 1000
    })
    
    const buffer = Buffer.from(response)
    const base64 = buffer.toString('base64')
    
    // 通过扩展名检测 MIME 类型
    let mimeType = 'image/jpeg'
    const urlLower = url.toLowerCase()
    if (urlLower.endsWith('.png')) {
      mimeType = 'image/png'
    } else if (urlLower.endsWith('.webp')) {
      mimeType = 'image/webp'
    } else if (urlLower.endsWith('.gif')) {
      mimeType = 'image/gif'
    }
    
    logger.debug('图片下载并转换为Base64', { url, mimeType, size: base64.length })
    return { data: base64, mimeType }
  } catch (error) {
    logger.error('下载图片失败', { url, error })
    throw new Error('下载图片失败，请检查图片链接是否有效')
  }
}

/**
 * 解析云雾响应，提取图片 URL
 */
function parseYunwuResponse(response: any): string[] {
  try {
    const images: string[] = []
    
    if (response.candidates && response.candidates.length > 0) {
      for (const candidate of response.candidates) {
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            // 检查是否有 inlineData（Base64 图片，驼峰命名）
            if (part.inlineData && part.inlineData.data) {
              const base64Data = part.inlineData.data
              const mimeType = part.inlineData.mimeType || 'image/jpeg'
              const dataUrl = `data:${mimeType};base64,${base64Data}`
              images.push(dataUrl)
            }
            // 兼容下划线命名
            else if (part.inline_data && part.inline_data.data) {
              const base64Data = part.inline_data.data
              const mimeType = part.inline_data.mime_type || 'image/jpeg'
              const dataUrl = `data:${mimeType};base64,${base64Data}`
              images.push(dataUrl)
            }
            // 检查是否有 fileData（文件引用）
            else if (part.fileData && part.fileData.fileUri) {
              images.push(part.fileData.fileUri)
            }
          }
        }
      }
    }
    
    return images
  } catch (error) {
    return []
  }
}

export class YunwuProvider implements ImageProvider {
  private config: YunwuConfig

  constructor(config: YunwuConfig) {
    this.config = config
  }

  async generateImages(prompt: string, imageUrls: string | string[], numImages: number): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const logger = this.config.logger
    const ctx = this.config.ctx
    
    logger.debug('开始下载图片并转换为Base64', { urls })
    
    // 下载所有图片并转换为 Base64
    const imageParts = []
    for (const url of urls) {
      const { data, mimeType } = await downloadImageAsBase64(
        ctx,
        url,
        this.config.apiTimeout,
        logger
      )
      imageParts.push({
        inline_data: {
          mime_type: mimeType,
          data: data
        }
      })
    }
    
    // 云雾 API 每次调用只能生成一张图片，需要循环调用
    const allImages: string[] = []
    
    for (let i = 0; i < numImages; i++) {
      // 构建 Gemini API 请求体
      const requestData = {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...imageParts
            ]
          }
        ],
        generationConfig: {
          responseModalities: ["IMAGE"]
        }
      }
      
      logger.debug('调用云雾图像编辑 API', { prompt, imageCount: urls.length, numImages, current: i + 1 })
      
      try {
        const response = await ctx.http.post(
          `https://yunwu.ai/v1beta/models/${this.config.modelId}:generateContent`,
          requestData,
          {
            headers: {
              'Content-Type': 'application/json'
            },
            params: {
              key: this.config.apiKey
            },
            timeout: this.config.apiTimeout * 1000
          }
        )
        
        const images = parseYunwuResponse(response)
        allImages.push(...images)
        
        logger.success('云雾图像编辑 API 调用成功', { current: i + 1, total: numImages })
      } catch (error: any) {
        // 清理敏感信息后再记录日志
        const safeMessage = typeof error?.message === 'string' ? sanitizeString(error.message) : '未知错误'
        
        logger.error('云雾图像编辑 API 调用失败', { 
          message: safeMessage,
          code: error?.code,
          status: error?.response?.status,
          current: i + 1,
          total: numImages
        })
        // 如果已经生成了一些图片，返回已生成的
        if (allImages.length > 0) {
          logger.warn('部分图片生成失败，返回已生成的图片', { generated: allImages.length, requested: numImages })
          break
        }
        throw new Error('图像处理API调用失败')
      }
    }
    
    return allImages
  }
}

