import { VideoProvider } from './types'
import { YunwuVideoProvider, VideoApiFormat } from './yunwu-video'
import { GPTGodVideoProvider, GPTGodVideoApiFormat } from './gptgod-video'

export type VideoProviderType = 'yunwu' | 'gptgod'
export type VideoApiFormatType = VideoApiFormat

export interface VideoProviderFactoryConfig {
  provider: VideoProviderType
  apiFormat?: VideoApiFormatType
  yunwuApiKey: string
  yunwuVideoModelId: string
  yunwuVideoApiBase: string
  gptgodVideoApiKey: string
  gptgodVideoModelId: string
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
        apiFormat: config.apiFormat || 'sora',
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger: config.logger,
        ctx: config.ctx
      })

    case 'gptgod':
      // GPTGod 不支持 seedance
      if (config.apiFormat === 'seedance') {
        throw new Error('GPTGod 不支持 Seedance 视频生成，请使用云雾供应商或将模型格式切换为 Sora/Veo/可灵')
      }
      
      return new GPTGodVideoProvider({
        apiKey: config.gptgodVideoApiKey,
        modelId: config.gptgodVideoModelId,
        apiBase: 'https://api.gptgod.online',
        apiFormat: (config.apiFormat as GPTGodVideoApiFormat) || 'sora',
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger: config.logger,
        ctx: config.ctx
      })

    default:
      throw new Error(`不支持的视频供应商类型: ${config.provider}`)
  }
}

export type { VideoProvider, VideoTaskStatus, VideoGenerationOptions } from './types'
export { YunwuVideoProvider } from './yunwu-video'
export { GPTGodVideoProvider } from './gptgod-video'
export type { VideoApiFormat } from './yunwu-video'
export type { GPTGodVideoApiFormat } from './gptgod-video'
