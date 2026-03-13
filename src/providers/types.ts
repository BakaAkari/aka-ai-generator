// 图像生成选项
export interface ImageGenerationOptions {
  resolution?: '1k' | '2k' | '4k'
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
}

// API 供应商接口定义

export interface ImageProvider {
  /**
   * 生成图像
   * @param prompt 提示词
   * @param imageUrls 输入图片 URL 数组
   * @param numImages 需要生成的图片数量
   * @param options 可选的图像生成选项（分辨率、宽高比等）
   * @param onImageGenerated 可选的回调函数，每生成一张图片时调用（用于流式处理）
   * @returns 生成的图片 URL 数组（data: URL 或 http URL）
   */
  generateImages(
    prompt: string, 
    imageUrls: string | string[], 
    numImages: number,
    options?: ImageGenerationOptions,
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
  // 可灵特有参数
  mode?: 'std' | 'pro'       // 生成模式：std 标准模式，pro 专家模式
  sound?: 'on' | 'off'       // 是否生成声音
  cameraControl?: any        // 相机控制参数
  multiShot?: boolean        // 是否生成多镜头视频
  // Veo 特有参数
  enhancePrompt?: boolean    // 是否自动增强提示词
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
    imageUrls: string | string[],
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
    imageUrls: string | string[],
    options?: VideoGenerationOptions,
    maxWaitTime?: number
  ): Promise<string>
}

// 兼容导出，避免可能的导入错误
export { sanitizeError, sanitizeString } from './utils'
