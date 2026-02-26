import { Context } from 'koishi'
import Jimp from 'jimp'

/**
 * 清理对象中的敏感信息（API KEY、密钥等）
 */
export function sanitizeError(error: any): any {
  if (!error) return error

  // 如果是字符串，尝试清理其中的 API KEY
  if (typeof error === 'string') {
    return sanitizeString(error)
  }

  // 如果是数组，递归处理每个元素
  if (Array.isArray(error)) {
    return error.map(item => sanitizeError(item))
  }

  // 如果是对象，创建副本并清理敏感字段
  if (typeof error === 'object') {
    const sanitized: any = {}

    for (const key in error) {
      const lowerKey = key.toLowerCase()

      // 跳过敏感字段
      if (
        lowerKey.includes('apikey') ||
        lowerKey.includes('api_key') ||
        lowerKey.includes('api-key') ||
        lowerKey === 'key' ||
        lowerKey === 'authorization' ||
        lowerKey === 'token' ||
        lowerKey === 'secret' ||
        lowerKey === 'password'
      ) {
        sanitized[key] = '[REDACTED]'
        continue
      }

      // 递归处理嵌套对象
      sanitized[key] = sanitizeError(error[key])
    }

    return sanitized
  }

  return error
}

/**
 * 清理字符串中的 API KEY 模式
 */
export function sanitizeString(str: string): string {
  if (typeof str !== 'string') return str

  // 匹配常见的 API KEY 模式并替换
  return str
    // 标准格式（key=xxx, apikey=xxx 等）- 降低长度阈值到 10 字符
    .replace(/key["'\s:=]+([a-zA-Z0-9_-]{10,})/gi, 'key="[REDACTED]"')
    .replace(/apikey["'\s:=]+([a-zA-Z0-9_-]{10,})/gi, 'apikey="[REDACTED]"')
    .replace(/api_key["'\s:=]+([a-zA-Z0-9_-]{10,})/gi, 'api_key="[REDACTED]"')
    .replace(/api-key["'\s:=]+([a-zA-Z0-9_-]{10,})/gi, 'api-key="[REDACTED]"')
    .replace(/x-api-key["'\s:=]+([a-zA-Z0-9_-]{10,})/gi, 'x-api-key="[REDACTED]"')

    // Authorization 头
    .replace(/authorization["'\s:=]+(Bearer\s+)?([a-zA-Z0-9_-]{10,})/gi, 'authorization="[REDACTED]"')
    .replace(/Bearer\s+([a-zA-Z0-9_-]{10,})/gi, 'Bearer [REDACTED]')

    // URL 中的 key 参数（?key=xxx 或 &key=xxx）
    .replace(/([?&])key=([a-zA-Z0-9_-]{10,})/gi, '$1key=[REDACTED]')
    .replace(/([?&])apikey=([a-zA-Z0-9_-]{10,})/gi, '$1apikey=[REDACTED]')
    .replace(/([?&])api_key=([a-zA-Z0-9_-]{10,})/gi, '$1api_key=[REDACTED]')
    .replace(/([?&])token=([a-zA-Z0-9_-]{10,})/gi, '$1token=[REDACTED]')
    .replace(/([?&])access_token=([a-zA-Z0-9_-]{10,})/gi, '$1access_token=[REDACTED]')

    // 常见云服务密钥模式
    .replace(/sk-[a-zA-Z0-9]{20,}/gi, '[REDACTED-SK]')  // OpenAI 风格
    .replace(/AIza[a-zA-Z0-9_-]{30,}/gi, '[REDACTED-GAPI]')  // Google API Key

    // Secret 和 Password 字段
    .replace(/secret["'\s:=]+([a-zA-Z0-9_-]{10,})/gi, 'secret="[REDACTED]"')
    .replace(/password["'\s:=]+([^\s"']{4,})/gi, 'password="[REDACTED]"')
}

/**
 * 下载图片并转换为 Base64
 * 包含 MIME 类型检测和大小限制
 * 支持 Koishi 内部协议 URL (如 internal:lark/... internal:onebot/... 等)
 */
export async function downloadImageAsBase64(
  ctx: Context,
  url: string,
  timeout: number,
  logger: any,
  maxSize: number = 10 * 1024 * 1024 // 默认最大 10MB
): Promise<{ data: string, mimeType: string }> {
  try {
    let buffer: Buffer

    // 检查是否为 Koishi 内部协议 URL（如 internal:lark/xxx, internal:onebot/xxx 等）
    if (url.startsWith('internal:')) {
      logger.debug('检测到 Koishi 内部协议 URL，使用 ctx.http.file() 获取', { url: url.substring(0, 80) })
      try {
        // 使用 ctx.http.file() 获取内部资源
        // 这是 Koishi/Satori 处理内部资源引用的标准方式
        const fileResult = await ctx.http.file(url, { timeout: timeout * 1000 })
        // ctx.http.file() 返回 { data: ArrayBuffer, type: string, filename?: string }
        buffer = Buffer.from(fileResult.data)
        logger.info('Koishi 内部协议资源获取成功', {
          url: url.substring(0, 80),
          size: buffer.length,
          type: fileResult.type
        })
      } catch (internalError: any) {
        logger.error('Koishi 内部协议资源获取失败', {
          url: url.substring(0, 80),
          error: sanitizeError(internalError),
          message: internalError?.message
        })
        throw new Error(`无法获取飞书/Lark 图片资源: ${internalError?.message || '未知错误'}`)
      }
    } else {
      // 标准 HTTP/HTTPS URL
      const response = await ctx.http.get(url, {
        responseType: 'arraybuffer',
        timeout: timeout * 1000,
        headers: {
          'Accept': 'image/*'
        }
      })
      buffer = Buffer.from(response)
    }
    if (buffer.length > maxSize) {
      throw new Error(`图片大小超过限制 (${(maxSize / 1024 / 1024).toFixed(1)}MB)`)
    }

    const base64 = buffer.toString('base64')

    // 优先从 Buffer 的魔数检测 MIME 类型
    let mimeType = 'image/jpeg' // 默认

    // 简单的魔数检测
    if (buffer.length > 4) {
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        mimeType = 'image/png'
      } else if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        mimeType = 'image/jpeg'
      } else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        mimeType = 'image/gif'
      } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        mimeType = 'image/webp'
      }
    }

    // 如果无法通过魔数检测，尝试使用后缀名
    if (mimeType === 'image/jpeg') { // 如果仍是默认值，尝试优化
      const urlLower = url.toLowerCase()
      if (urlLower.endsWith('.png')) {
        mimeType = 'image/png'
      } else if (urlLower.endsWith('.webp')) {
        mimeType = 'image/webp'
      } else if (urlLower.endsWith('.gif')) {
        mimeType = 'image/gif'
      }
    }

    // 特殊处理 GIF：Gemini 不支持 GIF，转为 PNG（自动取第一帧）
    if (mimeType === 'image/gif') {
      try {
        logger.debug('检测到 GIF 图片，正在转换为 PNG', { url })
        const image = await Jimp.read(buffer)
        const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG)

        // 更新 base64 和 mimeType
        const pngBase64 = pngBuffer.toString('base64')
        logger.info('GIF 已转换为 PNG', {
          originalSize: buffer.length,
          newSize: pngBuffer.length,
          width: image.getWidth(),
          height: image.getHeight()
        })

        return { data: pngBase64, mimeType: 'image/png' }
      } catch (conversionError: any) {
        logger.warn('GIF 转换失败，尝试原样发送', { error: conversionError?.message })
        // 如果转换失败，降级回原样发送（虽然可能会由于 API 不支持而失败）
      }
    }

    logger.debug('图片下载并转换为Base64', { url, mimeType, size: base64.length })
    return { data: base64, mimeType }
  } catch (error: any) {
    logger.error('下载图片失败', { url, error: sanitizeError(error) })

    if (error?.message?.includes('图片大小超过限制')) {
      throw error
    }
    throw new Error('下载图片失败，请检查图片链接是否有效')
  }
}
