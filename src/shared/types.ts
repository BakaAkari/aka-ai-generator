import type { ProviderType } from '../providers'

export type ImageProvider = 'yunwu' | 'gptgod' | 'gemini'
export type ApiFormat = 'gemini' | 'openai'

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  provider?: ImageProvider
  apiFormat?: ApiFormat
  /** 是否为受限模型，仅模型白名单内的用户可调用 */
  restricted?: boolean
}

export interface ImageGenerationModifiers {
  modelMapping?: ModelMappingConfig
  customAdditions?: string[]
  // resolution 支持预设值 (1k/2k/4k) 或自定义尺寸 (如 '1024x2048')
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
}

export interface StyleConfig {
  commandName: string
  description?: string
  prompt: string
  aliases?: string[]
  keywords?: string[]
  examples?: string[]
  category?: string
  whenToUse?: string
}

export interface StyleGroupConfig {
  prompts: StyleConfig[]
}

export interface VideoStyleConfig {
  commandName: string
  prompt: string
  duration?: number
  aspectRatio?: string
}

export interface ResolvedStyleConfig extends StyleConfig {
  groupName?: string
}

export interface StyleMatchCandidate {
  style: ResolvedStyleConfig
  score: number
  matchedTerms: string[]
}

export interface ImageRequestContext {
  numImages?: number
  provider?: ProviderType
  modelId?: string
  apiFormat?: ApiFormat
  // resolution 支持预设值 (1k/2k/4k) 或自定义尺寸 (如 '1024x2048')
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
}

export interface VideoModelConfig {
  singleImageModelId: string
  multiImageModelId: string
}

export interface GenerationDisplayInfo {
  customAdditions?: string[]
  modelId?: string
  modelDescription?: string
}

export interface GeneratedImageRecord {
  id: string
  conversationId: string
  userId: string
  createdAt: number
  source: 'generated' | 'upload' | 'quoted' | 'explicit'
  imageUrl: string
  prompt: string
  normalizedPrompt?: string
  provider: ProviderType
  modelId: string
  aspectRatio?: string
  resolution?: string
  stylePreset?: string
  parentRecordId?: string
}

export interface ConversationImageContext {
  conversationId: string
  lastGenerated?: GeneratedImageRecord
  recentRecords: GeneratedImageRecord[]
  pinnedStylePreset?: string
  pinnedCharacterNotes?: string
  lastUpdatedAt: number
}
