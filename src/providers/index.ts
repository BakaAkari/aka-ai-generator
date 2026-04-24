import { ImageProvider } from './types'
import { GptGodProvider } from './gptgod'
import { GeminiProvider } from './gemini'
import { OpenAIImagesProvider } from './openai-images'
import { GrokProvider } from './grok'

export type ProviderType = 'yunwu' | 'gptgod' | 'gemini' | 'grok'
export type ApiFormat = 'gemini' | 'openai'

export interface ProviderFactoryConfig {
  provider: ProviderType
  yunwuApiKey: string
  yunwuModelId: string
  yunwuApiFormat?: ApiFormat
  gptgodApiKey: string
  gptgodModelId: string
  geminiApiKey: string
  geminiModelId: string
  geminiApiBase: string
  grokApiKey: string
  grokModelId: string
  grokApiBase: string
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
      // 根据 apiFormat 选择对应的 Provider
      if (config.yunwuApiFormat === 'openai') {
        return new OpenAIImagesProvider({
          apiKey: config.yunwuApiKey,
          modelId: config.yunwuModelId,
          apiBase: 'https://yunwu.ai',
          apiTimeout: config.apiTimeout,
          logLevel: config.logLevel,
          logger: config.logger,
          ctx: config.ctx
        })
      }
      // 默认使用 Gemini 格式
      return new GeminiProvider({
        apiKey: config.yunwuApiKey,
        modelId: config.yunwuModelId,
        apiBase: 'https://yunwu.ai',
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

    case 'grok':
      return new GrokProvider({
        apiKey: config.grokApiKey,
        modelId: config.grokModelId,
        apiBase: config.grokApiBase,
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
export { OpenAIImagesProvider } from './openai-images'
export { GrokProvider } from './grok'
export { VideoProvider, VideoTaskStatus, VideoGenerationOptions } from './types'
export { YunwuVideoProvider } from './yunwu-video'
