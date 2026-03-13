// API 供应商接口定义

export interface ImageProvider {
  /**
   * 生成图像
   * @param prompt 提示词
   * @param imageUrls 输入图片 URL 数组
   * @param numImages 需要生成的图片数量
   * @param onImageGenerated 可选的回调函数，每生成一张图片时调用（用于流式处理）
   * @returns 生成的图片 URL 数组（data: URL 或 http URL）
   */
  generateImages(
    prompt: string, 
    imageUrls: string | string[], 
    numImages: number,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]>
}

export interface ProviderConfig {
  apiTimeout: number
  logLevel: 'info' | 'debug'
  logger: any
  ctx: any
}

// 视频生成选项
export interface VideoGenerationOptions {
  duration?: number          // 视频时长（秒）
  aspectRatio?: string       // 宽高比（如 "16:9", "9:16"）
  fps?: number              // 帧率
  style?: string            // 风格预设名称
}

// 视频任务状态
export interface VideoTaskStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  taskId: string
  videoUrl?: string
  error?: string
  progress?: number
}

// 视频 Provider 接口
export interface VideoProvider {
  /**
   * 创建视频生成任务
   * @returns 任务ID
   */
  createVideoTask(
    prompt: string,
    imageUrl: string,
    options?: VideoGenerationOptions
  ): Promise<string>

  /**
   * 查询任务状态
   */
  queryTaskStatus(taskId: string): Promise<VideoTaskStatus>

  /**
   * 生成视频（包含轮询等待）
   */
  generateVideo(
    prompt: string,
    imageUrl: string,
    options?: VideoGenerationOptions,
    maxWaitTime?: number
  ): Promise<string>
}

// 兼容导出，避免可能的导入错误
export { sanitizeError, sanitizeString } from './utils'
