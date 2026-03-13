import { ImageProvider } from './types'
import { GptGodProvider } from './gptgod'
import { GeminiProvider } from './gemini'

export type ProviderType = 'yunwu' | 'gptgod' | 'gemini'

export interface ProviderFactoryConfig {
  provider: ProviderType
  yunwuApiKey: string
  yunwuModelId: string
  gptgodApiKey: string
  gptgodModelId: string
  geminiApiKey: string
  geminiModelId: string
  geminiApiBase: string
  apiTimeout: number
  logLevel: 'info' | 'debug'
  logger: any
  ctx: any
}

/**
 * 创建图像生成供应商实例
 */
export function createImageProvider(config: ProviderFactoryConfig): ImageProvider {
  switch (config.provider) {
    case 'yunwu':
      // 云雾复用 Gemini Provider，但指定 API Base
      return new GeminiProvider({
        apiKey: config.yunwuApiKey,
        modelId: config.yunwuModelId,
        apiBase: 'https://yunwu.ai', // 指定云雾 API 地址
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger: config.logger,
        ctx: config.ctx
      })
    
    case 'gptgod':
      return new GptGodProvider({
        apiKey: config.gptgodApiKey,
        modelId: config.gptgodModelId,
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger: config.logger,
        ctx: config.ctx
      })

    case 'gemini':
      return new GeminiProvider({
        apiKey: config.geminiApiKey,
        modelId: config.geminiModelId,
        apiBase: config.geminiApiBase,
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger: config.logger,
        ctx: config.ctx
      })
    
    default:
      throw new Error(`不支持的供应商类型: ${config.provider}`)
  }
}

export { ImageProvider } from './types'
export { GptGodProvider } from './gptgod'
export { GeminiProvider } from './gemini'
export { VideoProvider, VideoTaskStatus, VideoGenerationOptions } from './types'
export { YunwuVideoProvider } from './yunwu-video'
