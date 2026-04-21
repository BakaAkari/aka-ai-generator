import { Schema } from 'koishi'
import type {
  ApiFormat,
  ImageProvider,
  ModelMappingConfig,
  StyleConfig,
  StyleGroupConfig,
  VideoStyleConfig,
} from './types'

export interface Config {
  provider: ImageProvider
  yunwuApiKey?: string
  yunwuModelId?: string
  yunwuApiFormat?: ApiFormat
  gptgodApiKey?: string
  gptgodModelId?: string
  geminiApiKey?: string
  geminiModelId?: string
  geminiApiBase?: string
  modelMappings?: ModelMappingConfig[]
  apiTimeout: number
  defaultNumImages: number
  showQuotaInImageCommands: boolean
  dailyFreeLimit: number
  unlimitedPlatforms: string[]
  rateLimitWindow: number
  rateLimitMax: number
  adminUsers: string[]
  permanentMembers: string[]
  modelWhitelistUsers: string[]
  styles: StyleConfig[]
  styleGroups?: Record<string, StyleGroupConfig>
  logLevel: 'info' | 'debug'
  securityBlockWindow: number
  securityBlockWarningThreshold: number
  enableVideoGeneration: boolean
  videoProvider: 'yunwu'
  videoApiKey: string
  videoApiBase: string
  singleImageVideoModel: string
  multiImageVideoModel: string
  videoMaxWaitTime: number
  videoCreditsMultiplier: number
  videoStyles: VideoStyleConfig[]
  chatlunaEnabled: boolean
  chatlunaContextInjectionEnabled: boolean
  chatlunaContextHistorySize: number
  chatlunaContextTtlSeconds: number
}

const StyleItemSchema = Schema.object({
  commandName: Schema.string().required().description('命令名称').role('table-cell', { width: 30 }),
  description: Schema.string().role('textarea', { rows: 2 }).description('指令描述'),
  prompt: Schema.string().role('textarea', { rows: 6 }).required().description('生成 prompt'),
})

const ProviderSchema = Schema.object({
  provider: Schema.union([
    Schema.const('yunwu').description('云雾'),
    Schema.const('gptgod').description('GPT God'),
    Schema.const('gemini').description('Google Gemini'),
  ]).default('yunwu').description('图像生成供应商'),
}).description('🎨 图像生成配置')

const ProviderConfigSchema = Schema.union([
  Schema.object({
    provider: Schema.const('yunwu'),
    yunwuApiKey: Schema.string().role('secret').required().description('云雾 API 密钥'),
    yunwuModelId: Schema.string().default('gemini-2.5-flash-image').description('云雾图像生成模型ID'),
    yunwuApiFormat: Schema.union([
      Schema.const('gemini').description('Gemini 原生'),
      Schema.const('openai').description('GPT Image'),
    ]).default('gemini').description('接口格式'),
    gptgodApiKey: Schema.string().role('secret').default('').hidden(),
    gptgodModelId: Schema.string().default('').hidden(),
    geminiApiKey: Schema.string().role('secret').default('').hidden(),
    geminiModelId: Schema.string().default('').hidden(),
    geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').hidden(),
  }),
  Schema.object({
    provider: Schema.const('gptgod'),
    gptgodApiKey: Schema.string().role('secret').required().description('GPT God API 密钥'),
    gptgodModelId: Schema.string().default('').description('GPT God 模型ID'),
    yunwuApiKey: Schema.string().role('secret').default('').hidden(),
    yunwuModelId: Schema.string().default('gemini-2.5-flash-image').hidden(),
    yunwuApiFormat: Schema.union([
      Schema.const('gemini'),
      Schema.const('openai'),
    ]).default('gemini').hidden(),
    geminiApiKey: Schema.string().role('secret').default('').hidden(),
    geminiModelId: Schema.string().default('').hidden(),
    geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').hidden(),
  }),
  Schema.object({
    provider: Schema.const('gemini'),
    geminiApiKey: Schema.string().role('secret').required().description('Google Gemini API 密钥'),
    geminiModelId: Schema.string().default('gemini-2.5-flash-image').description('Gemini 模型ID'),
    geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').description('Gemini API 地址'),
    yunwuApiKey: Schema.string().role('secret').default('').hidden(),
    yunwuModelId: Schema.string().default('gemini-2.5-flash-image').hidden(),
    yunwuApiFormat: Schema.union([
      Schema.const('gemini'),
      Schema.const('openai'),
    ]).default('gemini').hidden(),
    gptgodApiKey: Schema.string().role('secret').default('').hidden(),
    gptgodModelId: Schema.string().default('').hidden(),
  }),
])

export const Config: Schema<Config> = Schema.intersect([
  ProviderSchema,
  ProviderConfigSchema,

  Schema.object({
    apiTimeout: Schema.number().default(60).description('API请求超时时间（秒）'),
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .description('默认生成图片数量'),
  }).description('⚙️ 通用设置'),

  Schema.object({
    showQuotaInImageCommands: Schema.boolean()
      .default(true)
      .description('是否在“图像指令”列表中显示“图像额度”指令（仅影响列表显示）'),
    styles: Schema.array(StyleItemSchema).role('table').default([
      {
        commandName: '变手办',
        description: '图像风格转换',
        prompt: '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内',
      },
      {
        commandName: '变写实',
        description: '图像风格转换',
        prompt: '请根据用户提供的图片，在严格保持主体身份、外观特征与姿态不变的前提下，生成一张照片级真实感的超写实摄影作品。要求：1. 采用专业相机拍摄（如佳能EOS R5），使用85mm f/1.4人像镜头，呈现柯达Portra 400胶片质感，8K超高清画质，HDR高动态范围，电影级打光效果；2. 画面应具有照片级真实感、超现实主义风格和高细节表现，确保光影、皮肤质感、服饰纹理与背景环境都贴近真实世界；3. 使用自然光影营造真实氛围，呈现raw and natural的原始自然感，具有authentic film snapshot的真实胶片质感；4. 整体需具备tactile feel触感质感和simulated texture模拟纹理细节，可以适度优化噪点与瑕疵，但不要改变主体特征或添加额外元素；5. 整体效果需像专业摄影棚拍摄的真实照片，具有电影级画质；6. 如果主体是人物脸部，脸部生成效果应参考欧美混血白人精致美丽帅气英俊的外观特征进行生成，保持精致立体的五官轮廓、健康光泽的肌肤质感、优雅的气质和自然的表情，确保面部特征协调美观。',
      },
    ]).description('自定义风格命令配置（建议：描述概括效果，prompt 写细节）'),
    styleGroups: Schema.dict(Schema.object({
      prompts: Schema.array(StyleItemSchema)
        .role('table')
        .default([])
        .description('建议使用“指令描述”概括效果，prompt 写细节'),
    })).role('table').default({}).description('按类型管理的 prompt 组，键名即为分组名称'),
  }).description('🖼️ 图像生成').collapse(),

  Schema.object({
    modelMappings: Schema.array(Schema.object({
      suffix: Schema.string().required().description('切换模型参数名'),
      modelId: Schema.string().required().description('模型ID'),
      provider: Schema.union([
        Schema.const('yunwu').description('云雾 (yunwu)'),
        Schema.const('gptgod').description('GPT God'),
        Schema.const('gemini').description('Google Gemini'),
      ]).default('yunwu').description('供应商'),
      apiFormat: Schema.union([
        Schema.const('gemini').description('Gemini 原生'),
        Schema.const('openai').description('GPT Image'),
      ]).default('gemini').description('接口格式'),
      restricted: Schema.boolean().default(false).description('是否为受限模型（仅模型白名单用户可调用）'),
    }).collapse()).role('table').default([]).description('根据 -后缀切换模型'),
  }).description('🔀 模型映射'),

  Schema.object({
    dailyFreeLimit: Schema.number()
      .default(5)
      .min(1)
      .max(100)
      .description('每日免费调用次数'),
    unlimitedPlatforms: Schema.array(Schema.string())
      .default(['lark'])
      .description('不受配额限制的平台列表（如 lark, onebot, discord 等）'),
    rateLimitWindow: Schema.number()
      .default(300)
      .min(60)
      .max(3600)
      .description('限流时间窗口（秒）'),
    rateLimitMax: Schema.number()
      .default(3)
      .min(1)
      .max(20)
      .description('限流窗口内最大调用次数'),
  }).description('🚦 限流与配额'),

  Schema.object({
    securityBlockWindow: Schema.number()
      .default(600)
      .min(60)
      .max(3600)
      .description('安全策略拦截追踪时间窗口（秒）'),
    securityBlockWarningThreshold: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .description('安全策略拦截警示阈值，连续触发此次数后将发送警示'),
  }).description('🛡️ 安全策略'),

  Schema.object({
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户ID列表（拥有所有权限，不受任何限制）'),
    permanentMembers: Schema.array(Schema.string())
      .default([])
      .description('永久会员用户ID列表（无限量使用图像/视频生成，不受每日配额和限流限制）'),
    modelWhitelistUsers: Schema.array(Schema.string())
      .default([])
      .description('模型白名单用户ID列表（可调用标记为"受限"的模型，管理员自动拥有此权限）'),
    logLevel: Schema.union([
      Schema.const('info').description('普通信息'),
      Schema.const('debug').description('完整的debug信息'),
    ] as const)
      .default('info' as const)
      .description('日志输出详细程度'),
  }).description('👑 管理员设置'),

  Schema.object({
    chatlunaEnabled: Schema.boolean()
      .default(false)
      .description('是否启用内置 ChatLuna 工具桥接。开启后会尝试把图像能力注册到 ChatLuna。'),
    chatlunaContextInjectionEnabled: Schema.boolean()
      .default(true)
      .description('是否在 ChatLuna 对话前注入最近一次图像生成上下文。'),
    chatlunaContextHistorySize: Schema.number()
      .default(20)
      .min(1)
      .max(50)
      .description('每个 ChatLuna 会话保留的最近图像上下文数量。'),
    chatlunaContextTtlSeconds: Schema.number()
      .default(86400)
      .min(300)
      .max(2592000)
      .description('ChatLuna 图像上下文缓存保留时长（秒）。'),
  }).description('🌙 ChatLuna 集成'),

  Schema.object({
    enableVideoGeneration: Schema.boolean()
      .default(false)
      .description('启用图生成视频功能（消耗较大，需谨慎开启）'),
  }).description('🎬 视频生成'),

  Schema.union([
    Schema.object({
      enableVideoGeneration: Schema.const(true).required(),
      videoProvider: Schema.const('yunwu').default('yunwu').description('视频生成供应商（目前仅支持云雾）'),
      videoApiKey: Schema.string()
        .role('secret')
        .required()
        .description('云雾视频 API 密钥'),
      videoApiBase: Schema.string()
        .default('https://yunwu.ai')
        .description('云雾视频 API 地址'),
      singleImageVideoModel: Schema.string()
        .default('sora-2')
        .description('单图生视频模型ID（如 sora-2, kling-v2-master 等）'),
      multiImageVideoModel: Schema.string()
        .default('sora-2')
        .description('多图生视频模型ID（如 sora-2-storyboard, kling-multi-image 等）'),
      videoMaxWaitTime: Schema.number()
        .default(300)
        .min(60)
        .max(600)
        .description('视频生成最大等待时间（秒）'),
      videoCreditsMultiplier: Schema.number()
        .default(5)
        .min(1)
        .max(20)
        .description('视频生成积分倍数（相对于图片生成，默认5倍）'),
      videoStyles: Schema.array(Schema.object({
        commandName: Schema.string().required().description('命令名称').role('table-cell', { width: 100 }),
        prompt: Schema.string().role('textarea', { rows: 2 }).required().description('视频描述 prompt'),
        duration: Schema.number().default(15).description('视频时长（秒）'),
        aspectRatio: Schema.string().description('宽高比（如 16:9）'),
      })).role('table').default([
        {
          commandName: '变视频',
          prompt: '将该图片生成一段符合产品展现的流畅视频',
          duration: 15,
          aspectRatio: '16:9',
        },
      ]).description('视频风格预设'),
    }),
    Schema.object({
      videoProvider: Schema.const('yunwu').default('yunwu').hidden(),
      videoApiKey: Schema.string().role('secret').default('').hidden(),
      videoApiBase: Schema.string().default('https://yunwu.ai').hidden(),
      singleImageVideoModel: Schema.string().default('sora-2').hidden(),
      multiImageVideoModel: Schema.string().default('sora-2').hidden(),
      videoMaxWaitTime: Schema.number().default(300).hidden(),
      videoCreditsMultiplier: Schema.number().default(5).hidden(),
      videoStyles: Schema.array(Schema.object({
        commandName: Schema.string().required(),
        prompt: Schema.string().required(),
        duration: Schema.number().default(15),
        aspectRatio: Schema.string(),
      })).default([]).hidden(),
    }),
  ]),
])
