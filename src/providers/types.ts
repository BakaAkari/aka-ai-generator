// API 供应商接口定义

export interface ImageProvider {
  /**
   * 生成图像
   * @param prompt 提示词
   * @param imageUrls 输入图片 URL 数组
   * @param numImages 需要生成的图片数量
   * @returns 生成的图片 URL 数组（data: URL 或 http URL）
   */
  generateImages(prompt: string, imageUrls: string | string[], numImages: number): Promise<string[]>
}

export interface ProviderConfig {
  apiTimeout: number
  logLevel: 'info' | 'debug'
  logger: any
  ctx: any
}

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

