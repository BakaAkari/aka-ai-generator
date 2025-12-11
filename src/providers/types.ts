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

// 兼容导出，避免可能的导入错误
export { sanitizeError, sanitizeString } from './utils'
