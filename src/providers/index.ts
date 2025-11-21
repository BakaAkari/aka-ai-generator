import { ImageProvider } from './types'
import { YunwuProvider, YunwuConfig } from './yunwu'
import { GptGodProvider, GptGodConfig } from './gptgod'

export type ProviderType = 'yunwu' | 'gptgod'

export interface ProviderFactoryConfig {
  provider: ProviderType
  yunwuApiKey: string
  yunwuModelId: string
  gptgodApiKey: string
  gptgodModelId: string
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
      return new YunwuProvider({
        apiKey: config.yunwuApiKey,
        modelId: config.yunwuModelId,
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
    
    default:
      throw new Error(`不支持的供应商类型: ${config.provider}`)
  }
}

export { ImageProvider } from './types'
export { YunwuProvider } from './yunwu'
export { GptGodProvider } from './gptgod'

