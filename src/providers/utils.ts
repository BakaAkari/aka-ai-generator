import { Context } from 'koishi'

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
        lowerKey.includes('apikey') ||
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
    .replace(/key["\s:=]+([a-zA-Z0-9_-]{20,})/gi, 'key="[REDACTED]"')
    .replace(/apikey["\s:=]+([a-zA-Z0-9_-]{20,})/gi, 'apikey="[REDACTED]"')
    .replace(/api_key["\s:=]+([a-zA-Z0-9_-]{20,})/gi, 'api_key="[REDACTED]"')
    .replace(/authorization["\s:=]+(Bearer\s+)?([a-zA-Z0-9_-]{20,})/gi, 'authorization="[REDACTED]"')
    .replace(/Bearer\s+([a-zA-Z0-9_-]{20,})/gi, 'Bearer [REDACTED]')
}

/**
 * 下载图片并转换为 Base64
 * 包含 MIME 类型检测和大小限制
 */
export async function downloadImageAsBase64(
  ctx: Context,
  url: string,
  timeout: number,
  logger: any,
  maxSize: number = 10 * 1024 * 1024 // 默认最大 10MB
): Promise<{ data: string, mimeType: string }> {
  try {
    const response = await ctx.http.get(url, { 
      responseType: 'arraybuffer',
      timeout: timeout * 1000,
      headers: {
        'Accept': 'image/*'
      }
    })
    
    // 检查响应大小
    const buffer = Buffer.from(response)
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

