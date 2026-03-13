import { VideoProvider } from './types'
import { YunwuVideoProvider } from './yunwu-video'

export type VideoProviderType = 'yunwu'

export interface VideoProviderFactoryConfig {
  provider: VideoProviderType
  yunwuApiKey: string
  yunwuVideoModelId: string
  yunwuVideoApiBase: string
  yunwuMultiImageModelId?: string  // 多图生成视频模型ID
  apiTimeout: number
  logLevel: 'info' | 'debug'
  logger: any
  ctx: any
}

/**
 * 创建视频生成供应商实例
 */
export function createVideoProvider(config: VideoProviderFactoryConfig): VideoProvider {
  switch (config.provider) {
    case 'yunwu':
      return new YunwuVideoProvider({
        apiKey: config.yunwuApiKey,
        modelId: config.yunwuVideoModelId,
        apiBase: config.yunwuVideoApiBase,
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger: config.logger,
        ctx: config.ctx,
        multiImageModelId: config.yunwuMultiImageModelId
      })

    default:
      throw new Error(`不支持的视频供应商类型: ${config.provider}`)
  }
}

export type { VideoProvider, VideoTaskStatus, VideoGenerationOptions } from './types'
export { YunwuVideoProvider } from './yunwu-video'
