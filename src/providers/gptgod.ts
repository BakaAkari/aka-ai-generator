import { ImageProvider, ProviderConfig } from './types'

const GPTGOD_DEFAULT_API_URL = 'https://api.gptgod.online/v1/chat/completions'

export interface GptGodConfig extends ProviderConfig {
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
    
    // 优先使用响应头 content-type
    let mimeType = 'image/jpeg'
    const contentType = response.headers?.['content-type'] || response.headers?.['Content-Type']
    if (contentType && contentType.startsWith('image/')) {
      mimeType = contentType
    } else {
      // 回退到扩展名检测
      const urlLower = url.toLowerCase()
      if (urlLower.endsWith('.png')) {
        mimeType = 'image/png'
      } else if (urlLower.endsWith('.webp')) {
        mimeType = 'image/webp'
      } else if (urlLower.endsWith('.gif')) {
        mimeType = 'image/gif'
      }
    }
    
    logger.debug('图片下载并转换为Base64', { url, mimeType, size: base64.length })
    return { data: base64, mimeType }
  } catch (error) {
    logger.error('下载图片失败', { url, error })
    throw new Error('下载图片失败，请检查图片链接是否有效')
  }
}

/**
 * 解析 GPTGod 响应，提取图片 URL
 */
function parseGptGodResponse(response: any): string[] {
  try {
    const images: string[] = []
    
    // 检查是否有直接的图片 URL 数组
    if (Array.isArray(response.images)) {
      return response.images
    }
    
    // 检查是否有 data: URL
    if (response.image && typeof response.image === 'string' && response.image.startsWith('data:')) {
      images.push(response.image)
    }
    
    if (response?.choices?.length > 0) {
      const firstChoice = response.choices[0]
      const messageContent = firstChoice.message?.content
      let contentText = ''

      if (typeof messageContent === 'string') {
        contentText = messageContent
      } else if (Array.isArray(messageContent)) {
        contentText = messageContent.map((part: any) => part?.text || '').join('\n')
      } else if (messageContent?.text) {
        contentText = messageContent.text
      }

      // 匹配 Markdown 图片格式
      const mdImageRegex = /!\[.*?\]\((https?:\/\/[^\)]+)\)/g
      let match
      while ((match = mdImageRegex.exec(contentText)) !== null) {
        images.push(match[1])
      }

      // 匹配纯 URL
      if (images.length === 0) {
        const urlRegex = /(https?:\/\/[^\s"')]+\.(?:png|jpg|jpeg|webp|gif))/gi
        let urlMatch
        while ((urlMatch = urlRegex.exec(contentText)) !== null) {
          images.push(urlMatch[1])
        }
      }

      // 如果内容本身就是 URL
      if (images.length === 0 && contentText.trim().startsWith('http')) {
        images.push(contentText.trim())
      }
      
      // 检查是否有 data: URL
      const dataUrlRegex = /(data:image\/[^;]+;base64,[^\s"')]+)/gi
      let dataUrlMatch
      while ((dataUrlMatch = dataUrlRegex.exec(contentText)) !== null) {
        images.push(dataUrlMatch[1])
      }
    }
    
    return images
  } catch (error) {
    return []
  }
}

export class GptGodProvider implements ImageProvider {
  private config: GptGodConfig

  constructor(config: GptGodConfig) {
    this.config = config
  }

  async generateImages(prompt: string, imageUrls: string | string[], numImages: number): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const logger = this.config.logger
    const ctx = this.config.ctx

    if (!this.config.apiKey) {
      throw new Error('GPTGod 配置不完整，请检查 API Key')
    }

    logger.debug('调用 GPTGod 图像编辑 API', { prompt, imageCount: urls.length, numImages })

    const contentParts: any[] = [
      {
        type: 'text',
        text: `${prompt}\n请生成 ${numImages} 张图片。`
      }
    ]

    for (const url of urls) {
      const { data, mimeType } = await downloadImageAsBase64(
        ctx,
        url,
        this.config.apiTimeout,
        logger
      )
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${data}`
        }
      })
    }

    const requestData = {
      model: this.config.modelId,
      stream: false,
      n: numImages, // 使用 n 参数指定生成数量
      messages: [
        {
          role: 'user',
          content: contentParts
        }
      ]
    }

    try {
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
      
      logger.success('GPTGod 图像编辑 API 调用成功')
      const images = parseGptGodResponse(response)
      
      // 如果返回的图片数量不足，记录警告
      if (images.length < numImages) {
        logger.warn('生成的图片数量不足', { requested: numImages, received: images.length })
      }
      
      return images
    } catch (error: any) {
      logger.error('GPTGod 图像编辑 API 调用失败', {
        message: error?.message || '未知错误',
        code: error?.code,
        status: error?.response?.status,
        data: error?.response?.data
      })
      throw new Error('图像处理API调用失败')
    }
  }
}

