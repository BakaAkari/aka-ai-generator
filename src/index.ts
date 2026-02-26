import { Context, Schema, h, Session, Argv } from 'koishi'
import { createImageProvider, ProviderType } from './providers'
import { sanitizeError, sanitizeString } from './providers/utils'
import { UserManager, RechargeRecord } from './services/UserManager'
import { parseStyleCommandModifiers, buildModelMappingIndex } from './utils/parser'
import { join } from 'path'
import { YunwuVideoProvider } from './providers/yunwu-video'
import { runVideoGenerationFlow } from './orchestrators/VideoOrchestrator'

export const name = 'aka-ai-generator'

// 命令名称常量
const COMMANDS = {
  IMG_TO_IMG: '图生图',
  TXT_TO_IMG: '文生图',
  COMPOSE_IMAGE: '合成图',
  STYLE_TRANSFER: '风格迁移',
  CHANGE_POSE: '改姿势',
  OPTIMIZE_DESIGN: '修改设计',
  PIXELATE: '变像素',
  QUERY_QUOTA: '图像额度',
  RECHARGE: '图像充值',
  RECHARGE_ALL: '活动充值',
  RECHARGE_HISTORY: '图像充值记录',
  FUNCTION_LIST: '图像功能',
  IMAGE_COMMANDS: '图像指令'
} as const

export type ImageProvider = 'yunwu' | 'gptgod' | 'gemini'

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  provider?: ImageProvider
}

export interface StyleConfig {
  commandName: string
  description?: string
  prompt: string
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

interface ResolvedStyleConfig extends StyleConfig {
  groupName?: string
}

interface ImageRequestContext {
  numImages?: number
  provider?: ProviderType
  modelId?: string
}

// 插件配置接口
export interface Config {
  provider: ImageProvider
  yunwuApiKey: string
  yunwuModelId: string
  gptgodApiKey: string
  gptgodModelId: string
  geminiApiKey: string
  geminiModelId: string
  geminiApiBase: string
  modelMappings?: ModelMappingConfig[]
  apiTimeout: number
  commandTimeout: number
  defaultNumImages: number
  showQuotaInImageCommands: boolean
  dailyFreeLimit: number
  unlimitedPlatforms: string[]
  rateLimitWindow: number
  rateLimitMax: number
  adminUsers: string[]
  styles: StyleConfig[]
  styleGroups?: Record<string, StyleGroupConfig>
  logLevel: 'info' | 'debug'
  securityBlockWindow: number
  securityBlockWarningThreshold: number
  // 视频生成配置（独立于图像生成配置）
  enableVideoGeneration: boolean
  videoProvider: 'yunwu'  // 视频生成供应商（目前只支持 yunwu）
  videoApiKey: string     // 视频生成 API 密钥
  videoApiBase: string     // 视频生成 API 地址
  videoModelId: string     // 视频生成模型ID
  videoMaxWaitTime: number
  videoCreditsMultiplier: number
  videoStyles: VideoStyleConfig[]
}

const StyleItemSchema = Schema.object({
  commandName: Schema.string().required().description('命令名称').role('table-cell', { width: 30 }),
  description: Schema.string().role('textarea', { rows: 2 }).description('指令描述'),
  prompt: Schema.string().role('textarea', { rows: 6 }).required().description('生成 prompt')
})

export const Config: Schema<Config> = Schema.intersect([
  // ===== 1. 供应商选择 =====
  Schema.object({
    provider: Schema.union([
      Schema.const('yunwu').description('云雾 Gemini 服务'),
      Schema.const('gptgod').description('GPTGod 服务'),
      Schema.const('gemini').description('Google Gemini 原生'),
    ] as const)
      .default('yunwu' as ImageProvider)
      .description('图像生成供应商'),
  }).description('🎨 供应商选择'),

  // ===== 2. API 配置（根据 provider 条件显示） =====
  Schema.union([
    // GPTGod 配置 - 需要 required() 因为不是默认值
    Schema.object({
      provider: Schema.const('gptgod' as const).required(),
      gptgodApiKey: Schema.string().role('secret').required().description('GPTGod API 密钥'),
      gptgodModelId: Schema.string().default('nano-banana').description('GPTGod 模型ID'),
      // 其他 provider 的隐藏默认值
      yunwuApiKey: Schema.string().role('secret').default('').hidden(),
      yunwuModelId: Schema.string().default('gemini-2.5-flash-image').hidden(),
      geminiApiKey: Schema.string().role('secret').default('').hidden(),
      geminiModelId: Schema.string().default('gemini-2.5-flash').hidden(),
      geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').hidden(),
    }),
    // Gemini 配置 - 需要 required() 因为不是默认值
    Schema.object({
      provider: Schema.const('gemini' as const).required(),
      geminiApiKey: Schema.string().role('secret').required().description('Gemini API 密钥'),
      geminiModelId: Schema.string().default('gemini-2.5-flash').description('Gemini 模型ID'),
      geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').description('Gemini API 基础地址'),
      // 其他 provider 的隐藏默认值
      yunwuApiKey: Schema.string().role('secret').default('').hidden(),
      yunwuModelId: Schema.string().default('gemini-2.5-flash-image').hidden(),
      gptgodApiKey: Schema.string().role('secret').default('').hidden(),
      gptgodModelId: Schema.string().default('nano-banana').hidden(),
    }),
    // 云雾配置 - 不需要 required() 因为 'yunwu' 是默认值（放在最后作为 fallback）
    Schema.object({
      yunwuApiKey: Schema.string().role('secret').required().description('云雾 API 密钥'),
      yunwuModelId: Schema.string().default('gemini-2.5-flash-image').description('云雾图像生成模型ID'),
      // 其他 provider 的隐藏默认值
      gptgodApiKey: Schema.string().role('secret').default('').hidden(),
      gptgodModelId: Schema.string().default('nano-banana').hidden(),
      geminiApiKey: Schema.string().role('secret').default('').hidden(),
      geminiModelId: Schema.string().default('gemini-2.5-flash').hidden(),
      geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').hidden(),
    }),
  ] as const) as any,

  // ===== 3. 通用设置 =====
  Schema.object({
    apiTimeout: Schema.number().default(120).description('API请求超时时间（秒）'),
    commandTimeout: Schema.number().default(180).description('命令执行总超时时间（秒）'),
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .description('默认生成图片数量'),
  }).description('⚙️ 通用设置'),

  // ===== 4. 图像生成 =====
  Schema.object({
    showQuotaInImageCommands: Schema.boolean()
      .default(true)
      .description('是否在“图像指令”列表中显示“图像额度”指令（仅影响列表显示）'),
    styles: Schema.array(StyleItemSchema).role('table').default([
      {
        commandName: '变手办',
        description: '图像风格转换',
        prompt: '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内'
      },
      {
        commandName: '变写实',
        description: '图像风格转换',
        prompt: '请根据用户提供的图片，在严格保持主体身份、外观特征与姿态不变的前提下，生成一张照片级真实感的超写实摄影作品。要求：1. 采用专业相机拍摄（如佳能EOS R5），使用85mm f/1.4人像镜头，呈现柯达Portra 400胶片质感，8K超高清画质，HDR高动态范围，电影级打光效果；2. 画面应具有照片级真实感、超现实主义风格和高细节表现，确保光影、皮肤质感、服饰纹理与背景环境都贴近真实世界；3. 使用自然光影营造真实氛围，呈现raw and natural的原始自然感，具有authentic film snapshot的真实胶片质感；4. 整体需具备tactile feel触感质感和simulated texture模拟纹理细节，可以适度优化噪点与瑕疵，但不要改变主体特征或添加额外元素；5. 整体效果需像专业摄影棚拍摄的真实照片，具有电影级画质；6. 如果主体是人物脸部，脸部生成效果应参考欧美混血白人精致美丽帅气英俊的外观特征进行生成，保持精致立体的五官轮廓、健康光泽的肌肤质感、优雅的气质和自然的表情，确保面部特征协调美观。'
      },
    ]).description('自定义风格命令配置（建议：描述概括效果，prompt 写细节）'),
    styleGroups: Schema.dict(Schema.object({
      prompts: Schema.array(StyleItemSchema)
        .role('table')
        .default([])
        .description('建议使用“指令描述”概括效果，prompt 写细节')
    })).role('table').default({}).description('按类型管理的 prompt 组，键名即为分组名称'),
  }).description('🖼️ 图像生成').collapse(),

  // ===== 5. 模型映射 =====
  Schema.object({
    modelMappings: Schema.array(Schema.object({
      suffix: Schema.string().required().description('指令后缀（例如 4K，对应输入 -4K）'),
      provider: Schema.union([
        Schema.const('yunwu').description('云雾 Gemini 服务'),
        Schema.const('gptgod').description('GPTGod 服务'),
        Schema.const('gemini').description('Google Gemini 原生'),
      ] as const).description('可选：覆盖供应商'),
      modelId: Schema.string().required().description('触发该后缀时使用的模型 ID')
    })).role('table').default([]).description('根据 -后缀切换模型/供应商'),
  }).description('🔀 模型映射'),

  // ===== 6. 限流与配额 =====
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

  // ===== 7. 安全策略 =====
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

  // ===== 8. 管理员设置 =====
  Schema.object({
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户ID列表（不受每日使用限制）'),
    logLevel: Schema.union([
      Schema.const('info').description('普通信息'),
      Schema.const('debug').description('完整的debug信息'),
    ] as const)
      .default('info' as const)
      .description('日志输出详细程度'),
  }).description('👑 管理员设置'),

  // ===== 9. 视频生成（条件显示） =====
  Schema.object({
    enableVideoGeneration: Schema.boolean()
      .default(false)
      .description('启用图生成视频功能（消耗较大，需谨慎开启）'),
  }).description('🎬 视频生成'),

  Schema.union([
    Schema.object({
      enableVideoGeneration: Schema.const(true).required(),
      videoProvider: Schema.union([
        Schema.const('yunwu').description('云雾服务'),
      ] as const)
        .default('yunwu' as const)
        .description('视频生成供应商（目前只支持云雾）'),
      videoApiKey: Schema.string()
        .role('secret')
        .default('')
        .description('视频生成 API 密钥（独立于图像生成配置）'),
      videoApiBase: Schema.string()
        .default('https://yunwu.ai')
        .description('视频生成 API 地址'),
      videoModelId: Schema.string()
        .default('sora-2')
        .description('视频生成模型ID (sora-2 或 sora-2-pro)'),
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
        duration: Schema.number().default(15).description('视频时长（秒，仅支持 15 或 25）'),
        aspectRatio: Schema.string().description('宽高比（如 16:9）')
      })).role('table').default([
        {
          commandName: '变视频',
          prompt: '将该图片生成一段符合产品展现的流畅视频',
          duration: 15,
          aspectRatio: '16:9'
        }
      ]).description('视频风格预设'),
    }),
    Schema.object({
      videoProvider: Schema.union([Schema.const('yunwu')] as const).default('yunwu' as const).hidden(),
      videoApiKey: Schema.string().role('secret').default('').hidden(),
      videoApiBase: Schema.string().default('https://yunwu.ai').hidden(),
      videoModelId: Schema.string().default('sora-2').hidden(),
      videoMaxWaitTime: Schema.number().default(300).hidden(),
      videoCreditsMultiplier: Schema.number().default(5).hidden(),
      videoStyles: Schema.array(Schema.object({
        commandName: Schema.string().required(),
        prompt: Schema.string().required(),
        duration: Schema.number().default(15),
        aspectRatio: Schema.string()
      })).default([]).hidden(),
    }),
  ]),
]) as Schema<Config>

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-ai-generator')
  const userManager = new UserManager(ctx.baseDir, logger)

  // 移除 Provider 缓存，改为按需创建，支持热重载
  function getProviderInstance(providerType: ProviderType, modelId?: string) {
    return createImageProvider({
      provider: providerType,
      yunwuApiKey: config.yunwuApiKey,
      yunwuModelId: providerType === 'yunwu' ? (modelId || config.yunwuModelId) : config.yunwuModelId,
      gptgodApiKey: config.gptgodApiKey,
      gptgodModelId: providerType === 'gptgod' ? (modelId || config.gptgodModelId) : config.gptgodModelId,
      geminiApiKey: config.geminiApiKey,
      geminiModelId: providerType === 'gemini' ? (modelId || config.geminiModelId) : config.geminiModelId,
      geminiApiBase: config.geminiApiBase,
      apiTimeout: config.apiTimeout,
      logLevel: config.logLevel,
      logger,
      ctx
    })
  }

  const modelMappingIndex = buildModelMappingIndex(config.modelMappings)

  const STYLE_TRANSFER_PROMPT = '执行风格转换任务。收到两张图像：IMAGE_1是内容，IMAGE_2是风格。保留IMAGE_1的内容和结构，应用IMAGE_2的艺术风格，输出为1024x1024分辨率。内容锁定：严格保留IMAGE_1中的主体身份、姿势、动作、表情、服装款式、构图布局和背景元素，严禁改变IMAGE_1的几何结构和轮廓，不要引入IMAGE_2中的任何物体、人物、动作或形状。风格应用：分析IMAGE_2的视觉风格（艺术流派、色彩调性、笔触纹理、光影氛围、材质质感），将风格特征应用到IMAGE_1的内容上，让IMAGE_1看起来像是用IMAGE_2的画法重新绘制的。尺寸与填充：最终图像必须严格为1024x1024像素的正方形。如果IMAGE_1的原始比例不是正方形，保持IMAGE_1内容完整且不变形地放置在画面中心，对于周围多出的空白区域，根据IMAGE_1的背景内容和上下文逻辑，使用IMAGE_2的风格生成合理、连贯的背景延伸元素进行填充，确保画面完整自然，无明显接缝或黑边。'

  // 创建视频 Provider 实例（如果启用）
  let videoProvider: YunwuVideoProvider | null = null
  if (config.enableVideoGeneration) {
    // 验证视频配置
    if (!config.videoApiKey) {
      logger.warn('视频生成功能已启用，但未配置视频 API 密钥，视频功能将不可用')
    } else if (config.videoProvider !== 'yunwu') {
      logger.warn(`视频生成供应商 ${config.videoProvider} 暂不支持，仅支持 yunwu`)
    } else {
      videoProvider = new YunwuVideoProvider({
        apiKey: config.videoApiKey,
        modelId: config.videoModelId,
        apiBase: config.videoApiBase,
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger,
        ctx
      })
      logger.info(`视频生成功能已启用 (供应商: ${config.videoProvider}, 模型: ${config.videoModelId}, API: ${config.videoApiBase})`)
    }
  }

  // 获取动态风格指令
  const styleDefinitions = collectStyleDefinitions()

  function collectStyleDefinitions(): ResolvedStyleConfig[] {
    const unique = new Map<string, ResolvedStyleConfig>()

    const pushStyle = (style?: StyleConfig, groupName?: string) => {
      if (!style?.commandName || !style?.prompt) return
      if (unique.has(style.commandName)) {
        logger.warn('检测到重复的风格命令名称，已跳过', { commandName: style.commandName, groupName })
        return
      }
      unique.set(style.commandName, {
        ...style,
        groupName
      })
    }

    if (Array.isArray(config.styles)) {
      for (const style of config.styles) {
        pushStyle(style)
      }
    }

    if (config.styleGroups && typeof config.styleGroups === 'object') {
      for (const [groupName, group] of Object.entries(config.styleGroups)) {
        if (!groupName || !group || !Array.isArray(group.prompts)) continue
        for (const style of group.prompts) {
          pushStyle(style, groupName)
        }
      }
    }

    return Array.from(unique.values())
  }

  function getStyleCommands() {
    if (!styleDefinitions.length) return []
    return styleDefinitions
      .filter(style => style.commandName && style.prompt)
      .map(style => ({
        name: style.commandName,
        description: style.description || '图像风格转换'
      }))
  }

  // 指令管理系统
  const hasStyleTransferCommand = styleDefinitions.some(style => style.commandName === COMMANDS.STYLE_TRANSFER)

  const commandRegistry = {
    // 非管理员指令（包含动态风格指令）
    userCommands: [
      { name: COMMANDS.TXT_TO_IMG, description: '根据文字描述生成图像' },
      { name: COMMANDS.IMG_TO_IMG, description: '使用自定义prompt进行图像处理（图生图）' },
      { name: COMMANDS.COMPOSE_IMAGE, description: '合成多张图片，使用自定义prompt控制合成效果' },
      ...(hasStyleTransferCommand ? [] : [{ name: COMMANDS.STYLE_TRANSFER, description: '将第二张图片的视觉风格迁移至第一张图片' }]),
      ...getStyleCommands(),
      { name: COMMANDS.QUERY_QUOTA, description: '查询用户额度信息' }
    ],
    // 管理员指令
    adminCommands: [
      { name: COMMANDS.RECHARGE, description: '为用户充值次数（仅管理员）' },
      { name: COMMANDS.RECHARGE_ALL, description: '为所有用户充值次数（活动派发，仅管理员）' },
      { name: COMMANDS.RECHARGE_HISTORY, description: '查看充值历史记录（仅管理员）' }
    ]
  }

  // 通用输入获取函数
  async function getPromptInput(session: Session, message: string): Promise<string | null> {
    await session.send(message)
    const input = await session.prompt(30000) // 30秒超时
    return input || null
  }

  async function getStyleTransferImages(session: Session, imgParam: any): Promise<{ images: string[] } | { error: string }> {
    const collectedImages: string[] = []

    if (imgParam) {
      if (typeof imgParam === 'object' && imgParam.attrs?.src) {
        collectedImages.push(imgParam.attrs.src)
      } else if (typeof imgParam === 'string') {
        if (imgParam.startsWith('http') || imgParam.startsWith('data:')) {
          collectedImages.push(imgParam)
        }
      }
    }

    if (session.quote?.elements) {
      const quoteImages = h.select(session.quote.elements, 'img')
      for (const img of quoteImages) {
        if (img.attrs.src) collectedImages.push(img.attrs.src)
      }
    }

    if (collectedImages.length > 2) {
      return { error: '本功能仅支持两张图片，检测到多张图片' }
    }

    if (collectedImages.length === 2) {
      return { images: collectedImages }
    }

    await session.send('请依次发送两张图片：第一张为内容，第二张为风格')

    while (collectedImages.length < 2) {
      const msg = await session.prompt(30000)
      if (!msg) return { error: '等待超时' }

      const elements = h.parse(msg)
      const images = h.select(elements, 'img')
      const text = h.select(elements, 'text').map(e => e.attrs.content).join(' ').trim()

      if (images.length === 0) {
        return { error: text ? '未检测到图片，本功能需要两张图片' : '未检测到图片' }
      }

      for (const img of images) {
        if (img.attrs.src) collectedImages.push(img.attrs.src)
      }

      if (collectedImages.length > 2) {
        return { error: '本功能仅支持两张图片，检测到多张图片' }
      }

      if (collectedImages.length < 2) {
        await session.send(`已收到 ${collectedImages.length} 张图片，请继续发送第 ${collectedImages.length + 1} 张`)
      }
    }

    return { images: collectedImages }
  }

  // 构建统计消息
  function buildStatsMessage(userData: any, numImages: number, consumptionType: string, freeUsed: number, purchasedUsed: number, config: Config, platform?: string): string {
    const isAdmin = userManager.isAdmin(userData.userId, config)
    const isPlatformExempt = platform && config.unlimitedPlatforms?.includes(platform)

    if (isAdmin) {
      return `📊 使用统计 [管理员]\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`
    }

    if (isPlatformExempt) {
      return `📊 使用统计\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`
    }

    const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
    let consumptionText = ''
    if (consumptionType === 'mixed') {
      consumptionText = `每日免费次数 -${freeUsed}，充值次数 -${purchasedUsed}`
    } else if (consumptionType === 'free') {
      consumptionText = `每日免费次数 -${freeUsed}`
    } else {
      consumptionText = `充值次数 -${purchasedUsed}`
    }

    return `📊 使用统计\n用户：${userData.userName}\n本次生成：${numImages}张图片\n本次消费：${consumptionText}\n总调用次数：${userData.totalUsageCount}次\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次`
  }

  // 记录用户调用次数并发送统计信息（仅在成功时调用）
  // @param sendStatsImmediately 是否立即发送统计信息，false 时异步发送（不阻塞）
  async function recordUserUsage(session: Session, commandName: string, numImages: number = 1, sendStatsImmediately: boolean = true) {
    const userId = session.userId
    const userName = session.username || session.userId || '未知用户'
    const platform = session.platform
    if (!userId) return

    // 检查是否为平台免配额用户
    const isPlatformExempt = platform && config.unlimitedPlatforms?.includes(platform)
    const isAdmin = userManager.isAdmin(userId, config)

    let userData: any
    let consumptionType: 'free' | 'purchased' | 'mixed' = 'free'
    let freeUsed = 0
    let purchasedUsed = 0

    if (isAdmin || isPlatformExempt) {
      // 管理员或平台免配额用户：只记录调用次数，不扣减配额
      userData = await userManager.recordUsageOnly(userId, userName, commandName, numImages)
    } else {
      // 普通用户：扣减额度
      const result = await userManager.consumeQuota(userId, userName, commandName, numImages, config)
      userData = result.userData
      consumptionType = result.consumptionType
      freeUsed = result.freeUsed
      purchasedUsed = result.purchasedUsed
    }

    // 记录日志
    logger.info('用户调用记录', {
      userId,
      userName: userData.userName,
      commandName,
      numImages,
      consumptionType,
      freeUsed,
      purchasedUsed,
      totalUsageCount: userData.totalUsageCount,
      dailyUsageCount: userData.dailyUsageCount,
      remainingPurchasedCount: userData.remainingPurchasedCount,
      isAdmin,
      isPlatformExempt,
      platform
    })

    // 发送统计信息（可以失败，仅记录错误）
    if (sendStatsImmediately) {
      // 立即发送（同步阻塞）
      try {
        const statsMessage = buildStatsMessage(userData, numImages, consumptionType, freeUsed, purchasedUsed, config, platform)
        await session.send(statsMessage)
      } catch (error) {
        logger.warn('发送统计信息失败', { userId, error: sanitizeError(error) })
        // 不抛出错误，允许继续执行
      }
    } else {
      // 异步发送，不阻塞当前流程（优先发送图片）
      setImmediate(async () => {
        try {
          const statsMessage = buildStatsMessage(userData, numImages, consumptionType, freeUsed, purchasedUsed, config, platform)
          await session.send(statsMessage)
          logger.debug('统计信息已异步发送', { userId, commandName })
        } catch (error) {
          logger.warn('异步发送统计信息失败', { userId, error: sanitizeError(error) })
        }
      })
    }
  }

  // 记录安全策略拦截并处理警示/扣除积分逻辑
  async function recordSecurityBlock(session: Session, numImages: number = 1): Promise<void> {
    const userId = session.userId
    if (!userId) return

    const { shouldWarn, shouldDeduct, blockCount } = await userManager.recordSecurityBlock(userId, config)

    logger.info('安全策略拦截记录', {
      userId,
      blockCount,
      threshold: config.securityBlockWarningThreshold,
      shouldWarn,
      shouldDeduct,
      numImages
    })

    if (shouldWarn) {
      await session.send(`⚠️ 安全策略警示\n您已连续${config.securityBlockWarningThreshold}次触发安全策略拦截，再次发送被拦截内容将被扣除积分`)
      logger.warn('用户收到安全策略警示', { userId, blockCount, threshold: config.securityBlockWarningThreshold })
    } else if (shouldDeduct) {
      // 用户已收到警示，再次被拦截时扣除积分
      const commandName = '安全策略拦截'
      await recordUserUsage(session, commandName, numImages)
      logger.warn('用户因安全策略拦截被扣除积分', { userId, numImages })
    }
  }

  // 获取输入数据（支持单图/多图/纯文本）
  async function getInputData(session: Session, imgParam: any, mode: 'single' | 'multiple' | 'text'): Promise<{ images: string[], text?: string } | { error: string }> {
    const collectedImages: string[] = []
    let collectedText = ''

    // 0. 纯文本模式处理
    if (mode === 'text') {
      // 如果参数是字符串，直接作为 text
      if (typeof imgParam === 'string' && imgParam.trim()) {
        return { images: [], text: imgParam.trim() }
      }

      // 交互式获取
      await session.send('请输入画面描述')

      const msg = await session.prompt(30000)
      if (!msg) return { error: '等待超时' }

      const elements = h.parse(msg)
      const images = h.select(elements, 'img')
      if (images.length > 0) {
        return { error: '检测到图片，本功能仅支持文字输入' }
      }

      const text = h.select(elements, 'text').map(e => e.attrs.content).join(' ').trim()

      if (!text) {
        return { error: '未检测到描述，操作已取消' }
      }
      return { images: [], text }
    }

    // 1. 从命令参数获取
    if (imgParam) {
      if (typeof imgParam === 'object' && imgParam.attrs?.src) {
        collectedImages.push(imgParam.attrs.src)
      } else if (typeof imgParam === 'string') {
        // 简单的URL检查
        if (imgParam.startsWith('http') || imgParam.startsWith('data:')) {
          collectedImages.push(imgParam)
        }
      }
    }

    // 2. 从引用消息获取
    if (session.quote?.elements) {
      const quoteImages = h.select(session.quote.elements, 'img')
      for (const img of quoteImages) {
        if (img.attrs.src) collectedImages.push(img.attrs.src)
      }
    }

    // 如果已经有图片，直接返回
    if (collectedImages.length > 0) {
      if (mode === 'single') {
        if (collectedImages.length > 1) {
          return { error: '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图"命令' }
        }
        return { images: collectedImages }
      }
      return { images: collectedImages }
    }

    // 3. 交互式获取
    const promptMsg = mode === 'single' ? '请在30秒内发送一张图片' : '请发送图片（发送纯文字结束，至少需要2张）'
    await session.send(promptMsg)

    while (true) {
      const msg = await session.prompt(mode === 'multiple' ? 60000 : 30000)
      if (!msg) return { error: '等待超时' }

      // 调试日志：查看原始消息和平台信息
      logger.info('getInputData 收到消息', {
        platform: session.platform,
        msgType: typeof msg,
        msgLength: msg?.length,
        msgPreview: typeof msg === 'string' ? msg.substring(0, 200) : 'non-string',
        rawMsg: msg
      })

      const elements = h.parse(msg)

      // 调试日志：查看解析后的元素
      logger.info('getInputData 解析元素', {
        platform: session.platform,
        elementsCount: elements?.length,
        elementTypes: elements?.map(e => e.type),
        elementsDetail: JSON.stringify(elements?.slice(0, 5))
      })

      const images = h.select(elements, 'img')

      // 调试日志：查看选择的图片元素
      logger.info('getInputData 图片元素', {
        platform: session.platform,
        imagesCount: images?.length,
        imagesAttrs: images?.map(img => ({ src: img.attrs?.src?.substring(0, 100), allAttrs: Object.keys(img.attrs || {}) }))
      })
      const textElements = h.select(elements, 'text')
      const text = textElements.map(el => el.attrs.content).join(' ').trim()

      if (images.length > 0) {
        for (const img of images) {
          collectedImages.push(img.attrs.src)
        }

        if (mode === 'single') {
          if (collectedImages.length > 1) {
            return { error: '本功能仅支持处理一张图片，检测到多张图片' }
          }
          if (text) collectedText = text
          break
        }

        // 多图模式
        if (text) {
          collectedText = text
          break
        }

        await session.send(`已收到 ${collectedImages.length} 张图片，继续发送或输入文字结束`)
        continue
      }

      if (text) {
        if (collectedImages.length === 0) {
          return { error: '未检测到图片，请重新发起指令并发送图片' }
        }
        collectedText = text
        break
      }
    }

    return { images: collectedImages, text: collectedText }
  }

  // 使用供应商生成图像（支持流式处理）
  async function requestProviderImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    requestContext?: ImageRequestContext,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    const providerType = (requestContext?.provider || config.provider) as ProviderType
    const targetModelId = requestContext?.modelId
    const providerInstance = getProviderInstance(providerType, targetModelId)

    logger.info('requestProviderImages 调用', {
      providerType,
      modelId: targetModelId || 'default',
      numImages,
      hasCallback: !!onImageGenerated,
      promptLength: prompt.length,
      imageUrlsCount: Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0)
    })

    try {
      const result = await providerInstance.generateImages(prompt, imageUrls, numImages, onImageGenerated)
      logger.info('requestProviderImages 完成', {
        providerType,
        resultCount: result.length
      })
      return result
    } catch (error) {
      logger.error('requestProviderImages 失败', {
        providerType,
        error: sanitizeError(error),
        errorMessage: error?.message
      })
      throw error
    }
  }

  // 带超时的通用图像处理函数
  async function processImageWithTimeout(session: any, img: any, prompt: string, styleName: string, requestContext?: ImageRequestContext, displayInfo?: { customAdditions?: string[], modelId?: string, modelDescription?: string }, mode: 'single' | 'multiple' | 'text' = 'single') {
    const userId = session.userId
    let isTimeout = false

    return Promise.race([
      processImage(session, img, prompt, styleName, requestContext, displayInfo, mode, () => isTimeout),
      new Promise<string>((_, reject) =>
        setTimeout(() => {
          isTimeout = true
          reject(new Error('命令执行超时'))
        }, config.commandTimeout * 1000)
      )
    ]).catch(async error => {
      // 移除这里的 endTask，因为 processImage 的 finally 会处理
      const sanitizedError = sanitizeError(error)
      logger.error('图像处理超时或失败', { userId, error: sanitizedError })

      // 检测是否是安全策略拦截错误（超时错误除外）
      if (error?.message !== '命令执行超时') {
        const errorMessage = error?.message || ''
        const isSecurityBlock =
          errorMessage.includes('内容被安全策略拦截') ||
          errorMessage.includes('内容被安全策略阻止') ||
          errorMessage.includes('内容被阻止') ||
          errorMessage.includes('被阻止') ||
          errorMessage.includes('SAFETY') ||
          errorMessage.includes('RECITATION')

        if (isSecurityBlock) {
          // 记录安全策略拦截（使用请求的图片数量）
          const imageCount = requestContext?.numImages || config.defaultNumImages
          await recordSecurityBlock(session, imageCount)
        }
      }

      const safeMessage = typeof error?.message === 'string' ? sanitizeString(error.message) : '未知错误'
      return error.message === '命令执行超时' ? '图像处理超时，请重试' : `图像处理失败：${safeMessage}`
    })
  }

  async function processPresetImagesWithTimeout(
    session: any,
    imageUrls: string[],
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: { customAdditions?: string[], modelId?: string, modelDescription?: string }
  ) {
    const userId = session.userId
    let isTimeout = false

    return Promise.race([
      processPresetImages(session, imageUrls, prompt, styleName, requestContext, displayInfo, () => isTimeout),
      new Promise<string>((_, reject) =>
        setTimeout(() => {
          isTimeout = true
          reject(new Error('命令执行超时'))
        }, config.commandTimeout * 1000)
      )
    ]).catch(async error => {
      const sanitizedError = sanitizeError(error)
      logger.error('图像处理超时或失败', { userId, error: sanitizedError })

      if (error?.message !== '命令执行超时') {
        const errorMessage = error?.message || ''
        const isSecurityBlock =
          errorMessage.includes('内容被安全策略拦截') ||
          errorMessage.includes('内容被安全策略阻止') ||
          errorMessage.includes('内容被阻止') ||
          errorMessage.includes('被阻止') ||
          errorMessage.includes('SAFETY') ||
          errorMessage.includes('RECITATION')

        if (isSecurityBlock) {
          const imageCount = requestContext?.numImages || config.defaultNumImages
          await recordSecurityBlock(session, imageCount)
        }
      }

      const safeMessage = typeof error?.message === 'string' ? sanitizeString(error.message) : '未知错误'
      return error.message === '命令执行超时' ? '图像处理超时，请重试' : `图像处理失败：${safeMessage}`
    })
  }

  async function processPresetImages(
    session: any,
    imageUrls: string[],
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: { customAdditions?: string[], modelId?: string, modelDescription?: string },
    checkTimeout?: () => boolean
  ) {
    const userId = session.userId

    if (!userManager.startTask(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }

    try {
      const imageCount = requestContext?.numImages || config.defaultNumImages

      if (imageCount < 1 || imageCount > 4) {
        return '生成数量必须在 1-4 之间'
      }

      if (!imageUrls || imageUrls.length === 0) {
        return '未检测到输入图片，请发送两张图片'
      }

      if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

      let finalPrompt = (prompt || '').trim()
      if (!finalPrompt) {
        return '未检测到有效描述，操作已取消'
      }

      if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

      const providerType = (requestContext?.provider || config.provider) as ProviderType
      const providerModelId = requestContext?.modelId || (providerType === 'yunwu' ? config.yunwuModelId : config.gptgodModelId)

      logger.info('开始图像处理', {
        userId,
        imageUrls,
        styleName,
        prompt: finalPrompt,
        numImages: imageCount,
        provider: providerType,
        modelId: providerModelId
      })

      let statusMessage = `开始处理图片（${styleName}）`
      const infoParts: string[] = []

      if (displayInfo?.customAdditions && displayInfo.customAdditions.length > 0) {
        infoParts.push(`自定义内容：${displayInfo.customAdditions.join('；')}`)
      }

      if (displayInfo?.modelId) {
        const modelDesc = displayInfo.modelDescription || displayInfo.modelId
        infoParts.push(`使用模型：${modelDesc}`)
      }

      if (infoParts.length > 0) {
        statusMessage += `\n${infoParts.join('\n')}`
      }

      statusMessage += '...'
      await session.send(statusMessage)

      const generatedImages: string[] = []
      let creditDeducted = false

      const onImageGenerated = async (imageUrl: string, index: number, total: number) => {
        if (checkTimeout && checkTimeout()) {
          logger.error('流式回调：检测到超时', { userId, index, total })
          throw new Error('命令执行超时')
        }

        generatedImages.push(imageUrl)

        try {
          await session.send(h.image(imageUrl))
        } catch (sendError) {
          logger.error('发送图片失败', {
            userId,
            error: sanitizeError(sendError),
            errorMessage: sendError?.message,
            index: index + 1,
            total
          })
          throw sendError
        }

        if (!creditDeducted && generatedImages.length > 0) {
          creditDeducted = true
          try {
            await recordUserUsage(session, styleName, total, false)
          } catch (creditError) {
            logger.error('扣除积分失败', {
              userId,
              error: sanitizeError(creditError),
              totalImages: total
            })
          }
        }

        if (total > 1 && index < total - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      const images = await requestProviderImages(finalPrompt, imageUrls, imageCount, requestContext, onImageGenerated)

      if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

      if (images.length === 0) {
        return '图像处理失败：未能生成图片'
      }

      if (!creditDeducted) {
        await recordUserUsage(session, styleName, images.length, false)
        logger.warn('流式处理：积分在最后扣除（异常情况）', { userId, imagesCount: images.length })
      }

      await session.send('图像处理完成！')
    } finally {
      userManager.endTask(userId)
    }
  }

  // 通用图像处理函数
  async function processImage(
    session: any,
    img: any,
    prompt: string,
    styleName: string,
    requestContext?: ImageRequestContext,
    displayInfo?: { customAdditions?: string[], modelId?: string, modelDescription?: string },
    mode: 'single' | 'multiple' | 'text' = 'single',
    checkTimeout?: () => boolean
  ) {
    const userId = session.userId

    // 检查是否已有任务进行
    if (!userManager.startTask(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }

    try {
      // 获取参数
      const imageCount = requestContext?.numImages || config.defaultNumImages

      // 验证参数
      if (imageCount < 1 || imageCount > 4) {
        return '生成数量必须在 1-4 之间'
      }

      // 获取输入数据
      const inputResult = await getInputData(session, img, mode)
      if ('error' in inputResult) {
        return inputResult.error
      }

      // 每次耗时操作后检查是否超时
      if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

      const { images: imageUrls, text: extraText } = inputResult

      // 如果在交互中提供了额外文本，追加到 prompt
      let finalPrompt = prompt
      if (extraText) {
        finalPrompt += ' ' + extraText
      }
      finalPrompt = finalPrompt.trim()

      // 如果最终 prompt 为空（既没有预设 prompt，用户也没输入 prompt），则强制要求用户输入
      if (!finalPrompt) {
        await session.send('请发送画面描述')

        const promptMsg = await session.prompt(30000)
        if (!promptMsg) {
          return '未检测到描述，操作已取消'
        }
        const elements = h.parse(promptMsg)
        const images = h.select(elements, 'img')
        if (images.length > 0) {
          return '检测到图片，本功能仅支持文字输入'
        }
        const text = h.select(elements, 'text').map(e => e.attrs.content).join(' ').trim()
        if (text) {
          finalPrompt = text
        } else {
          return '未检测到有效文字描述，操作已取消'
        }
      }

      if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

      const providerType = (requestContext?.provider || config.provider) as ProviderType
      const providerModelId = requestContext?.modelId || (providerType === 'yunwu' ? config.yunwuModelId : config.gptgodModelId)

      logger.info('开始图像处理', {
        userId,
        imageUrls,
        styleName,
        prompt: finalPrompt,
        numImages: imageCount,
        provider: providerType,
        modelId: providerModelId
      })

      // 构建提示信息
      let statusMessage = `开始处理图片（${styleName}）`
      const infoParts: string[] = []

      if (displayInfo?.customAdditions && displayInfo.customAdditions.length > 0) {
        infoParts.push(`自定义内容：${displayInfo.customAdditions.join('；')}`)
      }

      if (displayInfo?.modelId) {
        const modelDesc = displayInfo.modelDescription || displayInfo.modelId
        infoParts.push(`使用模型：${modelDesc}`)
      }

      if (infoParts.length > 0) {
        statusMessage += `\n${infoParts.join('\n')}`
      }

      statusMessage += '...'

      // 调用图像编辑API
      await session.send(statusMessage)

      // 流式处理：收集已生成的图片，并在生成时立即发送
      const generatedImages: string[] = []
      let creditDeducted = false

      // 流式回调：每生成一张图片就立即发送
      const onImageGenerated = async (imageUrl: string, index: number, total: number) => {
        logger.info('流式回调被调用', {
          userId,
          index,
          total,
          imageUrlType: typeof imageUrl,
          imageUrlLength: imageUrl?.length || 0,
          imageUrlPrefix: imageUrl?.substring(0, 50) || 'null',
          hasImageUrl: !!imageUrl
        })

        // 检查超时
        if (checkTimeout && checkTimeout()) {
          logger.error('流式回调：检测到超时', { userId, index, total })
          throw new Error('命令执行超时')
        }

        generatedImages.push(imageUrl)
        logger.debug('图片已添加到 generatedImages', {
          userId,
          currentCount: generatedImages.length,
          index,
          total
        })

        // 1. 优先发送图片给用户（确保用户先看到结果）
        logger.info('准备发送图片', { userId, index: index + 1, total, imageUrlLength: imageUrl?.length || 0 })
        try {
          await session.send(h.image(imageUrl))
          logger.info('流式处理：图片已发送', { index: index + 1, total, userId })
        } catch (sendError) {
          logger.error('发送图片失败', {
            userId,
            error: sanitizeError(sendError),
            errorMessage: sendError?.message,
            index: index + 1,
            total
          })
          throw sendError // 重新抛出，让上层处理
        }

        // 2. 图片发送成功后，扣除积分（但不阻塞后续流程）
        if (!creditDeducted && generatedImages.length > 0) {
          creditDeducted = true
          logger.info('准备扣除积分', { userId, totalImages: total, currentIndex: index })
          try {
            // 传入 false，让统计信息异步发送，不阻塞后续流程
            await recordUserUsage(session, styleName, total, false)
            logger.info('流式处理：积分已扣除', {
              userId,
              totalImages: total,
              currentIndex: index
            })
          } catch (creditError) {
            logger.error('扣除积分失败', {
              userId,
              error: sanitizeError(creditError),
              totalImages: total
            })
            // 图片已发送，积分扣除失败不影响用户体验，只记录错误
          }
        }

        // 多张图片添加延时（最后一张不需要延时）
        if (total > 1 && index < total - 1) {
          logger.debug('多张图片，添加延时', { index, total })
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      logger.info('准备调用 requestProviderImages，已设置回调函数', {
        userId,
        hasCallback: !!onImageGenerated,
        imageCount,
        promptLength: finalPrompt.length,
        imageUrlsCount: Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0)
      })
      const images = await requestProviderImages(finalPrompt, imageUrls, imageCount, requestContext, onImageGenerated)
      logger.info('requestProviderImages 返回', {
        userId,
        imagesCount: images.length,
        generatedImagesCount: generatedImages.length,
        creditDeducted
      })

      // 立即检查超时
      if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

      if (images.length === 0) {
        return '图像处理失败：未能生成图片'
      }

      // 如果流式处理中积分未扣除（理论上不应该发生），在这里扣除
      if (!creditDeducted) {
        // 使用异步发送，因为此时图片已经发送完成
        await recordUserUsage(session, styleName, images.length, false)
        logger.warn('流式处理：积分在最后扣除（异常情况）', { userId, imagesCount: images.length })
      }

      await session.send('图像处理完成！')

    } finally {
      userManager.endTask(userId)
    }
  }


  // 动态注册风格命令
  if (styleDefinitions.length > 0) {
    for (const style of styleDefinitions) {
      if (style.commandName && style.prompt) {
        ctx.command(`${style.commandName} [img:text]`, style.description || '图像风格转换')
          .option('num', '-n <num:number> 生成图片数量 (1-4)')
          .option('multiple', '-m 允许多图输入')
          .action(async (argv, img) => {
            const { session, options } = argv
            if (!session?.userId) return '会话无效'

            const modifiers = parseStyleCommandModifiers(argv, img, modelMappingIndex)

            // 从用户自定义部分解析生成数量（不包括预设的 style.prompt）
            let userPromptParts: string[] = []
            if (modifiers.customAdditions?.length) {
              userPromptParts.push(...modifiers.customAdditions)
            }
            if (modifiers.customPromptSuffix) {
              userPromptParts.push(modifiers.customPromptSuffix)
            }
            const userPromptText = userPromptParts.join(' - ')

            // 确定要生成的图片数量（仅使用 -n 参数）
            const numImages = options?.num || config.defaultNumImages

            // 原子性地检查并预留额度（防止并发绕过）
            const userName = session.username || session.userId || '未知用户'
            const limitCheck = await userManager.checkAndReserveQuota(session.userId!, userName, numImages, config, session.platform)
            if (!limitCheck.allowed) {
              return limitCheck.message
            }

            // 构建最终的 prompt（保留预设的 style.prompt，添加用户输入）
            const promptSegments = [style.prompt]
            if (userPromptText) {
              promptSegments.push(userPromptText)
            }
            const mergedPrompt = promptSegments.filter(Boolean).join(' - ')

            const requestContext: ImageRequestContext = {
              numImages: numImages
            }
            if (modifiers.modelMapping?.provider) {
              requestContext.provider = modifiers.modelMapping.provider as ProviderType
            }
            if (modifiers.modelMapping?.modelId) {
              requestContext.modelId = modifiers.modelMapping.modelId
            }

            // 准备显示信息
            const displayInfo: { customAdditions?: string[], modelId?: string, modelDescription?: string } = {}
            if (modifiers.customAdditions && modifiers.customAdditions.length > 0) {
              displayInfo.customAdditions = modifiers.customAdditions
            }
            if (modifiers.modelMapping?.modelId) {
              displayInfo.modelId = modifiers.modelMapping.modelId
              displayInfo.modelDescription = modifiers.modelMapping.suffix || modifiers.modelMapping.modelId
            }

            const mode = options?.multiple ? 'multiple' : 'single'
            return processImageWithTimeout(session, img, mergedPrompt, style.commandName, requestContext, displayInfo, mode)
          })

        logger.info(`已注册命令: ${style.commandName}`)
      }
    }
  }

  // 图生视频命令（基础）
  if (config.enableVideoGeneration && videoProvider) {
    ctx.command('图生视频 [img:text]', '根据图片和描述生成视频')
      .option('duration', '-d <duration:number> 视频时长（15 或 25 秒）')
      .option('ratio', '-r <ratio:string> 宽高比（16:9, 9:16, 1:1）')
      .action(async ({ session, options }, img) => {
        if (!session?.userId) return '会话无效'

        const userId = session.userId
        const userName = session.username || userId || '未知用户'

        // 计算积分消耗
        const videoCredits = config.videoCreditsMultiplier

        // 检查并预留额度
        const limitCheck = await userManager.checkAndReserveQuota(
          userId,
          userName,
          videoCredits,
          config,
          session.platform
        )
        if (!limitCheck.allowed) {
          return limitCheck.message
        }

        // 检查视频任务锁（独立于图像任务，不影响图像生成）
        if (!userManager.startVideoTask(userId)) {
          return '您有一个视频任务正在进行中，请等待完成'
        }

        // 获取输入图片
        const inputResult = await getInputData(session, img, 'single')
        if ('error' in inputResult) {
          userManager.endVideoTask(userId)
          return inputResult.error
        }

        const { images: imageUrls, text: extraText } = inputResult

        if (imageUrls.length === 0) {
          userManager.endVideoTask(userId)
          return '未检测到输入图片，请发送一张图片'
        }

        // 获取描述
        let prompt = extraText || ''
        if (!prompt) {
          await session.send('请输入视频描述（描述视频中的动作和场景变化）\n提示：描述越详细，生成效果越好')
          const promptMsg = await session.prompt(30000)
          if (!promptMsg) {
            userManager.endVideoTask(userId)
            return '等待超时'
          }
          const elements = h.parse(promptMsg)
          const text = h.select(elements, 'text').map(e => e.attrs.content).join(' ').trim()
          if (!text) {
            userManager.endVideoTask(userId)
            return '未检测到描述'
          }
          prompt = text
        }

        // 验证时长参数（API 只支持 15 或 25 秒）
        const duration = options?.duration || 15
        if (duration !== 15 && duration !== 25) {
          userManager.endVideoTask(userId)
          return '视频时长必须是 15 或 25 秒'
        }

        // 验证宽高比参数
        const ratio = options?.ratio || '16:9'
        const validRatios = ['16:9', '9:16', '1:1']
        if (!validRatios.includes(ratio)) {
          userManager.endVideoTask(userId)
          return `宽高比必须是以下之一: ${validRatios.join(', ')}`
        }

        return runVideoGenerationFlow({
          session,
          userId,
          userManager,
          videoProvider,
          logger,
          sanitizeString,
          sanitizeError,
          recordUserUsage,
          commandName: '图生视频',
          prompt,
          imageUrl: imageUrls[0],
          videoCredits,
          maxWaitTime: config.videoMaxWaitTime,
          startMessage: '开始生成视频...',
          videoOptions: {
            duration,
            aspectRatio: ratio
          }
        })
      })
  }

  // 查询视频任务命令（taskId 可选：不传则查询用户所有待生成任务）
  if (config.enableVideoGeneration && videoProvider) {
    ctx.command('查询视频 [taskId:string]', '查询视频生成状态（不传任务ID则查询自己所有待生成任务）')
      .action(async ({ session }, taskId) => {
        if (!session?.userId) return '会话无效'

        const trimmedTaskId = (taskId || '').trim()

        // 如果指定了 taskId，查询单个任务
        if (trimmedTaskId) {
          try {
            await session.send('正在查询视频生成状态...')

            const status = await videoProvider.queryTaskStatus(trimmedTaskId)
            const pending = await userManager.getPendingVideoTask(trimmedTaskId)

            // 验证任务归属
            if (pending && pending.userId && pending.userId !== session.userId) {
              return '该任务ID不属于当前用户，无法查询'
            }

            if (status.status === 'completed' && status.videoUrl) {
              await session.send(h.video(status.videoUrl))

              // 若存在待结算记录，则在查询成功时补扣积分（避免超时套利）
              if (pending && !pending.charged) {
                await recordUserUsage(session, pending.commandName, pending.credits, false)
                await userManager.markPendingVideoTaskCharged(trimmedTaskId)
                await userManager.deletePendingVideoTask(trimmedTaskId)
              }

              return '视频生成完成！'
            } else if (status.status === 'processing' || status.status === 'pending') {
              const progressText = status.progress ? `（进度：${status.progress}%）` : ''
              return `视频正在生成中${progressText}，请稍后再次查询`
            } else if (status.status === 'failed') {
              // 失败的任务移除但不扣费
              if (pending && !pending.charged) {
                await userManager.deletePendingVideoTask(trimmedTaskId)
              }
              return `视频生成失败：${status.error || '未知错误'}`
            } else {
              return `❓ 未知状态：${status.status}`
            }

          } catch (error: any) {
            logger.error('查询视频任务失败', { taskId: trimmedTaskId, error: sanitizeError(error) })
            return `查询失败：${sanitizeString(error.message)}`
          }
        }

        // 未指定 taskId，查询用户所有待生成任务
        try {
          const pendingTasks = await userManager.listPendingVideoTasksForUser(session.userId)

          if (pendingTasks.length === 0) {
            return '你当前没有可查询的待生成视频任务'
          }

          await session.send(`正在查询 ${pendingTasks.length} 个视频任务状态...`)

          let completedCount = 0
          let processingCount = 0
          let failedCount = 0
          const messages: string[] = []

          // 逐个查询任务状态
          for (const task of pendingTasks) {
            try {
              const status = await videoProvider.queryTaskStatus(task.taskId)

              if (status.status === 'completed' && status.videoUrl) {
                // 发送视频并在发送后扣费
                await session.send(h.video(status.videoUrl))

                if (!task.charged) {
                  await recordUserUsage(session, task.commandName, task.credits, false)
                  await userManager.markPendingVideoTaskCharged(task.taskId)
                  await userManager.deletePendingVideoTask(task.taskId)
                }
                completedCount++
                messages.push(`任务 ${task.taskId.substring(0, 20)}... 已完成`)
              } else if (status.status === 'processing' || status.status === 'pending') {
                processingCount++
                const progressText = status.progress ? `（进度：${status.progress}%）` : ''
                messages.push(`任务 ${task.taskId.substring(0, 20)}... 生成中${progressText}`)
              } else if (status.status === 'failed') {
                // 失败的任务移除但不扣费
                if (!task.charged) {
                  await userManager.deletePendingVideoTask(task.taskId)
                }
                failedCount++
                messages.push(`任务 ${task.taskId.substring(0, 20)}... 失败：${status.error || '未知错误'}`)
              } else {
                messages.push(`❓ 任务 ${task.taskId.substring(0, 20)}... 状态：${status.status}`)
              }
            } catch (error: any) {
              logger.error('查询单个视频任务失败', { taskId: task.taskId, error: sanitizeError(error) })
              messages.push(`⚠️ 任务 ${task.taskId.substring(0, 20)}... 查询失败：${sanitizeString(error.message)}`)
            }
          }

          // 汇总结果
          let summary = `查询结果汇总：\n`
          if (completedCount > 0) summary += `已完成：${completedCount} 个\n`
          if (processingCount > 0) summary += `生成中：${processingCount} 个\n`
          if (failedCount > 0) summary += `失败：${failedCount} 个\n`
          summary += `\n${messages.join('\n')}`

          return summary

        } catch (error: any) {
          logger.error('查询视频任务列表失败', { userId: session.userId, error: sanitizeError(error) })
          return `查询失败：${sanitizeString(error.message)}`
        }
      })
  }

  // 动态注册视频风格命令
  if (config.enableVideoGeneration && videoProvider && config.videoStyles?.length > 0) {
    for (const style of config.videoStyles) {
      if (!style.commandName || !style.prompt) continue

      ctx.command(`${style.commandName} [img:text]`, '视频风格转换')
        .action(async ({ session }, img) => {
          if (!session?.userId) return '会话无效'

          const userId = session.userId
          const userName = session.username || userId || '未知用户'

          // 计算积分消耗
          const videoCredits = config.videoCreditsMultiplier

          // 检查并预留额度
          const limitCheck = await userManager.checkAndReserveQuota(
            userId,
            userName,
            videoCredits,
            config,
            session.platform
          )
          if (!limitCheck.allowed) {
            return limitCheck.message
          }

          // 检查视频任务锁（独立于图像任务，不影响图像生成）
          if (!userManager.startVideoTask(userId)) {
            return '您有一个视频任务正在进行中，请等待完成'
          }

          // 获取输入图片
          const inputResult = await getInputData(session, img, 'single')
          if ('error' in inputResult) {
            userManager.endVideoTask(userId)
            return inputResult.error
          }

          const { images: imageUrls, text: extraText } = inputResult

          if (imageUrls.length === 0) {
            userManager.endVideoTask(userId)
            return '未检测到输入图片，请发送一张图片'
          }

          // 构建最终 prompt（预设 + 用户追加）
          let finalPrompt = style.prompt
          if (extraText) {
            finalPrompt += ' - ' + extraText
          }

          return runVideoGenerationFlow({
            session,
            userId,
            userManager,
            videoProvider,
            logger,
            sanitizeString,
            sanitizeError,
            recordUserUsage,
            commandName: style.commandName,
            prompt: finalPrompt,
            imageUrl: imageUrls[0],
            videoCredits,
            maxWaitTime: config.videoMaxWaitTime,
            startMessage: `开始生成视频（${style.commandName}）...`,
            videoOptions: {
              duration: style.duration || 15,
              aspectRatio: style.aspectRatio || '16:9'
            }
          })
        })

      logger.info(`已注册视频风格命令: ${style.commandName}`)
    }
  }

  // 文生图命令
  ctx.command(`${COMMANDS.TXT_TO_IMG} [prompt:text]`, '根据文字描述生成图像')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async (argv, prompt) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'
      const numImages = options?.num || config.defaultNumImages

      // 解析模型映射（支持 -4k 等后缀）
      const modifiers = parseStyleCommandModifiers(argv, prompt, modelMappingIndex)

      // 原子性地检查并预留额度（防止并发绕过）
      const userName = session.username || session.userId || '未知用户'
      const limitCheck = await userManager.checkAndReserveQuota(session.userId!, userName, numImages, config, session.platform)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const requestContext: ImageRequestContext = {
        numImages: numImages
      }

      // 应用模型映射
      if (modifiers.modelMapping?.provider) {
        requestContext.provider = modifiers.modelMapping.provider as ProviderType
      }
      if (modifiers.modelMapping?.modelId) {
        requestContext.modelId = modifiers.modelMapping.modelId
      }

      // 准备显示信息
      const displayInfo: { customAdditions?: string[], modelId?: string, modelDescription?: string } = {}
      if (modifiers.modelMapping?.modelId) {
        displayInfo.modelId = modifiers.modelMapping.modelId
        displayInfo.modelDescription = modifiers.modelMapping.suffix || modifiers.modelMapping.modelId
      }

      return processImageWithTimeout(session, prompt, '', COMMANDS.TXT_TO_IMG, requestContext, displayInfo, 'text')
    })

  // 图生图命令（自定义prompt）
  ctx.command(`${COMMANDS.IMG_TO_IMG} [img:text]`, '使用自定义prompt进行图像处理')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .option('multiple', '-m 允许多图输入')
    .action(async (argv, img) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'
      const numImages = options?.num || config.defaultNumImages
      const mode = options?.multiple ? 'multiple' : 'single'

      // 解析模型映射（支持 -4k 等后缀）
      const modifiers = parseStyleCommandModifiers(argv, img, modelMappingIndex)

      // 原子性地检查并预留额度（防止并发绕过）
      const userName = session.username || session.userId || '未知用户'
      const limitCheck = await userManager.checkAndReserveQuota(session.userId!, userName, numImages, config, session.platform)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const requestContext: ImageRequestContext = {
        numImages: numImages
      }

      // 应用模型映射
      if (modifiers.modelMapping?.provider) {
        requestContext.provider = modifiers.modelMapping.provider as ProviderType
      }
      if (modifiers.modelMapping?.modelId) {
        requestContext.modelId = modifiers.modelMapping.modelId
      }

      // 准备显示信息
      const displayInfo: { customAdditions?: string[], modelId?: string, modelDescription?: string } = {}
      if (modifiers.modelMapping?.modelId) {
        displayInfo.modelId = modifiers.modelMapping.modelId
        displayInfo.modelDescription = modifiers.modelMapping.suffix || modifiers.modelMapping.modelId
      }

      // 使用通用处理函数，prompt 为空字符串，让其通过交互或 img 参数获取
      return processImageWithTimeout(session, img, '', COMMANDS.IMG_TO_IMG, requestContext, displayInfo, mode)
    })

  // 风格迁移命令（两张图片）
  if (!hasStyleTransferCommand) {
    ctx.command(`${COMMANDS.STYLE_TRANSFER} [img:text]`, '将第二张图片的视觉风格迁移至第一张图片')
      .option('num', '-n <num:number> 生成图片数量 (1-4)')
      .action(async (argv, img) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'

      const numImages = options?.num || config.defaultNumImages

      const modifiers = parseStyleCommandModifiers(argv, img, modelMappingIndex)

      const userName = session.username || session.userId || '未知用户'
      const limitCheck = await userManager.checkAndReserveQuota(session.userId!, userName, numImages, config, session.platform)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const inputResult = await getStyleTransferImages(session, img)
      if ('error' in inputResult) {
        return inputResult.error
      }

      const requestContext: ImageRequestContext = {
        numImages: numImages
      }

      if (modifiers.modelMapping?.provider) {
        requestContext.provider = modifiers.modelMapping.provider as ProviderType
      }
      if (modifiers.modelMapping?.modelId) {
        requestContext.modelId = modifiers.modelMapping.modelId
      }

      const displayInfo: { customAdditions?: string[], modelId?: string, modelDescription?: string } = {}
      if (modifiers.modelMapping?.modelId) {
        displayInfo.modelId = modifiers.modelMapping.modelId
        displayInfo.modelDescription = modifiers.modelMapping.suffix || modifiers.modelMapping.modelId
      }

      return processPresetImagesWithTimeout(session, inputResult.images, STYLE_TRANSFER_PROMPT, COMMANDS.STYLE_TRANSFER, requestContext, displayInfo)
      })
  }

  // 合成图命令（多张图片合成）
  ctx.command(COMMANDS.COMPOSE_IMAGE, '合成多张图片，使用自定义prompt控制合成效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async (argv) => {
      const { session, options } = argv
      if (!session?.userId) return '会话无效'
      const userId = session.userId

      // 解析模型映射（支持 -4k 等后缀）
      const modifiers = parseStyleCommandModifiers(argv, undefined, modelMappingIndex)

      // 直接加锁，不要先检查再释放再加锁
      if (!userManager.startTask(userId)) {
        return '您有一个图像处理任务正在进行中，请等待完成'
      }

      let isTimeout = false
      return Promise.race([
        (async () => {
          try {
            // 等待用户发送多张图片和prompt
            await session.send('多张图片+描述')

            const collectedImages: string[] = []
            let prompt = ''

            // 循环接收消息，直到收到纯文字消息作为 prompt
            while (true) {
              const msg = await session.prompt(60000) // 60秒超时
              if (!msg) {
                return '等待超时，请重试'
              }
              if (isTimeout) throw new Error('命令执行超时')

              const elements = h.parse(msg)
              const images = h.select(elements, 'img')
              const textElements = h.select(elements, 'text')
              const text = textElements.map(el => el.attrs.content).join(' ').trim()

              // 如果有图片，收集图片
              if (images.length > 0) {
                for (const img of images) {
                  collectedImages.push(img.attrs.src)
                }

                // 如果同时有文字，作为 prompt 并结束
                if (text) {
                  prompt = text
                  break
                }

                // 只有图片，继续等待
                await session.send(`已收到 ${collectedImages.length} 张图片，继续发送或输入描述`)
                continue
              }

              // 如果只有文字
              if (text) {
                if (collectedImages.length < 2) {
                  return `需要至少两张图片进行合成，当前只有 ${collectedImages.length} 张图片`
                }
                prompt = text
                break
              }

              // 既没有图片也没有文字
              return '未检测到有效内容，操作已取消'
            }

            // 验证
            if (collectedImages.length < 2) {
              return '需要至少两张图片进行合成，请重新发送'
            }

            if (!prompt) {
              return '未检测到prompt描述，请重新发送'
            }

            const imageCount = options?.num || config.defaultNumImages

            // 验证参数
            if (imageCount < 1 || imageCount > 4) {
              return '生成数量必须在 1-4 之间'
            }

            // 原子性地检查并预留额度（防止并发绕过）
            const userName = session.username || userId || '未知用户'
            const limitCheck = await userManager.checkAndReserveQuota(userId, userName, imageCount, config, session.platform)
            if (!limitCheck.allowed) {
              return limitCheck.message
            }

            if (isTimeout) throw new Error('命令执行超时')

            // 构建 requestContext
            const requestContext: ImageRequestContext = {
              numImages: imageCount
            }
            if (modifiers.modelMapping?.provider) {
              requestContext.provider = modifiers.modelMapping.provider as ProviderType
            }
            if (modifiers.modelMapping?.modelId) {
              requestContext.modelId = modifiers.modelMapping.modelId
            }

            logger.info('开始图片合成处理', {
              userId,
              imageUrls: collectedImages,
              prompt,
              numImages: imageCount,
              imageCount: collectedImages.length,
              modelMapping: modifiers.modelMapping ? { provider: modifiers.modelMapping.provider, modelId: modifiers.modelMapping.modelId } : null
            })

            // 调用图像编辑API（支持多张图片）
            let statusMessage = `开始合成图（${collectedImages.length}张）...`
            if (modifiers.modelMapping?.modelId) {
              statusMessage += `\n使用模型：${modifiers.modelMapping.suffix || modifiers.modelMapping.modelId}`
            }
            statusMessage += `\nPrompt: ${prompt}`
            await session.send(statusMessage)

            // 流式处理：收集已生成的图片，并在生成时立即发送
            const generatedImages: string[] = []
            let creditDeducted = false

            // 流式回调：每生成一张图片就立即发送
            const onImageGenerated = async (imageUrl: string, index: number, total: number) => {
              logger.info('流式回调被调用 (COMPOSE_IMAGE)', {
                userId,
                index,
                total,
                imageUrlType: typeof imageUrl,
                imageUrlLength: imageUrl?.length || 0,
                imageUrlPrefix: imageUrl?.substring(0, 50) || 'null',
                hasImageUrl: !!imageUrl
              })

              // 检查超时
              if (isTimeout) {
                logger.error('流式回调：检测到超时 (COMPOSE_IMAGE)', { userId, index, total })
                throw new Error('命令执行超时')
              }

              generatedImages.push(imageUrl)
              logger.debug('图片已添加到 generatedImages (COMPOSE_IMAGE)', {
                userId,
                currentCount: generatedImages.length,
                index,
                total
              })

              // 1. 优先发送图片给用户（确保用户先看到结果）
              logger.info('准备发送图片 (COMPOSE_IMAGE)', { userId, index: index + 1, total, imageUrlLength: imageUrl?.length || 0 })
              try {
                await session.send(h.image(imageUrl))
                logger.info('流式处理：图片已发送 (COMPOSE_IMAGE)', { index: index + 1, total, userId })
              } catch (sendError) {
                logger.error('发送图片失败 (COMPOSE_IMAGE)', {
                  userId,
                  error: sanitizeError(sendError),
                  errorMessage: sendError?.message,
                  index: index + 1,
                  total
                })
                throw sendError // 重新抛出，让上层处理
              }

              // 2. 图片发送成功后，扣除积分（但不阻塞后续流程）
              if (!creditDeducted && generatedImages.length > 0) {
                creditDeducted = true
                logger.info('准备扣除积分 (COMPOSE_IMAGE)', { userId, totalImages: total, currentIndex: index })
                try {
                  // 传入 false，让统计信息异步发送，不阻塞后续流程
                  await recordUserUsage(session, COMMANDS.COMPOSE_IMAGE, total, false)
                  logger.info('流式处理：积分已扣除 (COMPOSE_IMAGE)', {
                    userId,
                    totalImages: total,
                    currentIndex: index
                  })
                } catch (creditError) {
                  logger.error('扣除积分失败 (COMPOSE_IMAGE)', {
                    userId,
                    error: sanitizeError(creditError),
                    totalImages: total
                  })
                  // 图片已发送，积分扣除失败不影响用户体验，只记录错误
                }
              }

              // 多张图片添加延时（最后一张不需要延时）
              if (total > 1 && index < total - 1) {
                logger.debug('多张图片，添加延时 (COMPOSE_IMAGE)', { index, total })
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }

            logger.info('准备调用 requestProviderImages (COMPOSE_IMAGE)，已设置回调函数', {
              userId,
              hasCallback: !!onImageGenerated,
              imageCount,
              promptLength: prompt.length,
              collectedImagesCount: collectedImages.length,
              modelId: requestContext.modelId || 'default'
            })
            const resultImages = await requestProviderImages(prompt, collectedImages, imageCount, requestContext, onImageGenerated)
            logger.info('requestProviderImages 返回 (COMPOSE_IMAGE)', {
              userId,
              imagesCount: resultImages.length,
              generatedImagesCount: generatedImages.length,
              creditDeducted
            })

            // 立即检查超时
            if (isTimeout) throw new Error('命令执行超时')

            if (resultImages.length === 0) {
              return '图片合成失败：未能生成图片'
            }

            // 如果流式处理中积分未扣除（理论上不应该发生），在这里扣除
            if (!creditDeducted) {
              // 使用异步发送，因为此时图片已经发送完成
              await recordUserUsage(session, COMMANDS.COMPOSE_IMAGE, resultImages.length, false)
              logger.warn('流式处理：积分在最后扣除（异常情况）', { userId, imagesCount: resultImages.length })
            }

            await session.send('图片合成完成！')

          } finally {
            userManager.endTask(userId)
          }
        })(),
        new Promise<string>((_, reject) =>
          setTimeout(() => {
            isTimeout = true
            reject(new Error('命令执行超时'))
          }, config.commandTimeout * 1000)
        )
      ]).catch(async error => {
        // 不需要再次 endTask，finally 已处理
        const sanitizedError = sanitizeError(error)
        logger.error('图片合成超时或失败', { userId, error: sanitizedError })

        // 检测是否是安全策略拦截错误（超时错误除外）
        if (error?.message !== '命令执行超时') {
          const errorMessage = error?.message || ''
          const isSecurityBlock =
            errorMessage.includes('内容被安全策略拦截') ||
            errorMessage.includes('内容被安全策略阻止') ||
            errorMessage.includes('内容被阻止') ||
            errorMessage.includes('被阻止') ||
            errorMessage.includes('SAFETY') ||
            errorMessage.includes('RECITATION')

          if (isSecurityBlock) {
            // 记录安全策略拦截（使用请求的图片数量）
            const imageCount = options?.num || config.defaultNumImages
            await recordSecurityBlock(session, imageCount)
          }
        }

        const safeMessage = typeof error?.message === 'string' ? sanitizeString(error.message) : '未知错误'
        return error.message === '命令执行超时' ? '图片合成超时，请重试' : `图片合成失败：${safeMessage}`
      })
    })

  // 充值管理命令
  ctx.command(`${COMMANDS.RECHARGE} [content:text]`, '为用户充值次数（仅管理员）')
    .action(async ({ session }, content) => {
      if (!session?.userId) return '会话无效'

      // 检查管理员权限
      if (!userManager.isAdmin(session.userId, config)) {
        return '权限不足，仅管理员可操作'
      }

      // 获取要解析的内容
      const inputContent = content || await getPromptInput(session, '请输入充值信息，格式：\n@用户1 @用户2 充值次数 [备注]')
      if (!inputContent) return '输入超时或无效'

      // 解析输入内容
      const elements = h.parse(inputContent)
      const atElements = h.select(elements, 'at')
      const textElements = h.select(elements, 'text')
      const text = textElements.map(el => el.attrs.content).join(' ').trim()

      if (atElements.length === 0) {
        return '未找到@用户，请使用@用户的方式'
      }

      // 解析充值次数和备注
      const parts = text.split(/\s+/).filter(p => p)
      if (parts.length === 0) {
        return '请输入充值次数'
      }

      const amount = parseInt(parts[0])
      const note = parts.slice(1).join(' ') || '管理员充值'

      if (!amount || amount <= 0) {
        return '充值次数必须大于0'
      }

      const userIds = atElements.map(el => el.attrs.id).filter(Boolean)

      if (userIds.length === 0) {
        return '未找到有效的用户，请使用@用户的方式'
      }

      try {
        const now = new Date().toISOString()
        const recordId = `recharge_${now.replace(/[-:T.]/g, '').slice(0, 14)}_${Math.random().toString(36).substr(2, 3)}`
        const targets: RechargeRecord['targets'] = []
        let totalAmount = 0

        // 批量更新用户数据
        await userManager.updateUsersBatch((usersData) => {
          for (const userId of userIds) {
            if (!userId) continue

            let userName = userId
            if (usersData[userId]) {
              userName = usersData[userId].userName || userId
            } else {
              // 创建新用户
              usersData[userId] = {
                userId,
                userName: userId,
                totalUsageCount: 0,
                dailyUsageCount: 0,
                lastDailyReset: now,
                purchasedCount: 0,
                remainingPurchasedCount: 0,
                donationCount: 0,
                donationAmount: 0,
                lastUsed: now,
                createdAt: now
              }
            }

            const beforeBalance = usersData[userId].remainingPurchasedCount
            usersData[userId].purchasedCount += amount
            usersData[userId].remainingPurchasedCount += amount

            targets.push({
              userId,
              userName,
              amount,
              beforeBalance,
              afterBalance: usersData[userId].remainingPurchasedCount
            })
          }
          totalAmount = amount * targets.length
        })

        // 记录充值历史
        await userManager.addRechargeRecord({
          id: recordId,
          timestamp: now,
          type: targets.length > 1 ? 'batch' : 'single',
          operator: {
            userId: session.userId,
            userName: session.username || session.userId
          },
          targets,
          totalAmount,
          note,
          metadata: {}
        })

        const userList = targets.map(t => `${t.userName}(${t.afterBalance}次)`).join(', ')
        return `✅ 充值成功\n目标用户：${userList}\n充值次数：${amount}次/人\n总充值：${totalAmount}次\n操作员：${session.username}\n备注：${note}`

      } catch (error) {
        logger.error('充值操作失败', error)
        return '充值失败，请稍后重试'
      }
    })

  // 全员活动充值命令
  ctx.command(`${COMMANDS.RECHARGE_ALL} [content:text]`, '为所有用户充值次数（活动派发，仅管理员）')
    .action(async ({ session }, content) => {
      if (!session?.userId) return '会话无效'

      // 检查管理员权限
      if (!userManager.isAdmin(session.userId, config)) {
        return '权限不足，仅管理员可操作'
      }

      // 获取要解析的内容
      const inputContent = content || await getPromptInput(session, '请输入活动充值信息，格式：\n充值次数 [备注]\n例如：20 或 20 春节活动奖励')
      if (!inputContent) return '输入超时或无效'

      // 解析输入内容
      const elements = h.parse(inputContent)
      const textElements = h.select(elements, 'text')
      const text = textElements.map(el => el.attrs.content).join(' ').trim()

      // 解析充值次数和备注
      const parts = text.split(/\s+/).filter(p => p)
      if (parts.length === 0) {
        return '请输入充值次数，例如：图像活动充值 20 或 图像活动充值 20 活动名称'
      }

      const amount = parseInt(parts[0])
      const note = parts.slice(1).join(' ') || '活动充值'

      if (!amount || amount <= 0) {
        return '充值次数必须大于0'
      }

      try {
        const now = new Date().toISOString()
        const recordId = `recharge_all_${now.replace(/[-:T.]/g, '').slice(0, 14)}_${Math.random().toString(36).substr(2, 3)}`
        const targets: RechargeRecord['targets'] = []
        let totalAmount = 0
        let successCount = 0

        // 批量更新所有用户
        await userManager.updateUsersBatch((usersData) => {
          const allUserIds = Object.keys(usersData)
          for (const userId of allUserIds) {
            if (!userId || !usersData[userId]) continue

            const userData = usersData[userId]
            const beforeBalance = userData.remainingPurchasedCount

            userData.purchasedCount += amount
            userData.remainingPurchasedCount += amount

            targets.push({
              userId,
              userName: userData.userName || userId,
              amount,
              beforeBalance,
              afterBalance: userData.remainingPurchasedCount
            })
            successCount++
          }
          totalAmount = amount * successCount
        })

        if (successCount === 0) {
          return '当前没有使用过插件的用户，无法进行活动充值'
        }

        // 记录充值历史
        await userManager.addRechargeRecord({
          id: recordId,
          timestamp: now,
          type: 'all',
          operator: {
            userId: session.userId,
            userName: session.username || session.userId
          },
          targets,
          totalAmount,
          note,
          metadata: { all: true }
        })

        return `✅ 活动充值成功\n目标用户数：${successCount}人\n充值次数：${amount}次/人\n总充值：${totalAmount}次\n操作员：${session.username}\n备注：${note}`

      } catch (error) {
        logger.error('活动充值操作失败', error)
        return '活动充值失败，请稍后重试'
      }
    })

  // 额度查询命令
  ctx.command(`${COMMANDS.QUERY_QUOTA} [target:text]`, '查询用户额度信息')
    .action(async ({ session }, target) => {
      if (!session?.userId) return '会话无效'

      const userIsAdmin = userManager.isAdmin(session.userId, config)
      let targetUserId = session.userId
      let targetUserName = session.username || session.userId

      // 如果指定了目标用户且是管理员
      if (target && userIsAdmin) {
        const userMatch = target.match(/<at id="([^"]+)"/)
        if (userMatch) {
          targetUserId = userMatch[1]
          targetUserName = '目标用户'
        }
      } else if (target && !userIsAdmin) {
        return '权限不足，仅管理员可查询其他用户'
      }

      try {
        const userData = await userManager.getUserData(targetUserId, targetUserName)

        // 这里的 userData 虽然是初始化的（如果用户不存在），但也符合查询逻辑
        const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
        const totalAvailable = remainingToday + userData.remainingPurchasedCount

        return `👤 用户额度信息\n用户：${userData.userName}\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次\n总可用次数：${totalAvailable}次\n历史总调用：${userData.totalUsageCount}次\n历史总充值：${userData.purchasedCount}次`

      } catch (error) {
        logger.error('查询额度失败', error)
        return '查询失败，请稍后重试'
      }
    })

  // 充值记录查询命令
  ctx.command(`${COMMANDS.RECHARGE_HISTORY} [page:number]`, '查看充值历史记录（仅管理员）')
    .action(async ({ session }, page = 1) => {
      if (!session?.userId) return '会话无效'

      if (!userManager.isAdmin(session.userId, config)) {
        return '权限不足，仅管理员可查看充值记录'
      }

      try {
        const history = await userManager.loadRechargeHistory()
        const pageSize = 10
        const totalPages = Math.ceil(history.records.length / pageSize)
        const startIndex = (page - 1) * pageSize
        const endIndex = startIndex + pageSize
        const records = history.records.slice(startIndex, endIndex).reverse() // 最新的在前

        if (records.length === 0) {
          return `📋 充值记录\n当前页：${page}/${totalPages}\n暂无充值记录`
        }

        let result = `📋 充值记录 (第${page}/${totalPages}页)\n\n`

        for (const record of records) {
          const date = new Date(record.timestamp).toLocaleString('zh-CN')
          const userList = record.targets.map(t => `${t.userName}(${t.amount}次)`).join(', ')
          result += `🕐 ${date}\n👤 操作员：${record.operator.userName}\n👥 目标：${userList}\n💰 总充值：${record.totalAmount}次\n📝 备注：${record.note}\n\n`
        }

        return result

      } catch (error) {
        logger.error('查询充值记录失败', error)
        return '查询失败，请稍后重试'
      }
    })

  // 图像功能列表命令
  ctx.command(COMMANDS.FUNCTION_LIST, '查看所有可用的图像处理功能')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'

      try {
        // 获取当前用户的管理员状态
        const userIsAdmin = userManager.isAdmin(session.userId, config)

        let result = '🎨 图像处理功能列表\n\n'

        // 显示非管理员指令
        result += '📝 用户指令：\n'
        commandRegistry.userCommands.forEach(cmd => {
          result += `• ${cmd.name} - ${cmd.description}\n`
        })

        // 如果启用了视频生成功能，显示视频功能
        if (config.enableVideoGeneration) {
          result += '\n🎥 视频生成功能：\n'
          result += '• 图生视频 - 根据图片和描述生成视频\n'
          result += '• 查询视频 - 根据任务ID查询视频状态\n'

          if (config.videoStyles?.length > 0) {
            config.videoStyles.forEach(style => {
              result += `• ${style.commandName} - 视频风格预设\n`
            })
          }
        }

        // 如果用户是管理员，显示管理员指令
        if (userIsAdmin) {
          result += '\n🔧 管理员指令：\n'
          commandRegistry.adminCommands.forEach(cmd => {
            result += `• ${cmd.name} - ${cmd.description}\n`
          })
        }

        result += '\n💡 使用提示：\n'
        result += '• 发送图片后使用相应指令进行图像处理\n'
        result += '• 支持直接传参：.指令名 [图片] 参数\n'
        result += '• 支持交互式输入：.指令名 然后按提示操作\n'

        if (userIsAdmin) {
          result += '\n🔑 管理员提示：\n'
          result += '• 可使用所有功能，无使用限制\n'
          result += '• 可以查看充值记录\n'
          result += '• 可以为其他用户充值次数\n'
        } else {
          result += '\n👤 普通用户提示：\n'
          result += '• 每日有免费使用次数限制\n'
          result += '• 可使用充值次数进行额外调用\n'
          result += '• 使用 .图像额度 查看剩余次数\n'
        }

        return result

      } catch (error) {
        logger.error('获取功能列表失败', error)
        return '获取功能列表失败，请稍后重试'
      }
    })


  // 图像指令列表命令
  ctx.command(COMMANDS.IMAGE_COMMANDS, '查看图像生成指令列表')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'

      // 获取全局 prefix
      const globalConfig = ctx.root.config as any
      const prefixConfig = globalConfig.prefix

      let prefix = ''
      if (Array.isArray(prefixConfig) && prefixConfig.length > 0) {
        prefix = prefixConfig[0]
      } else if (typeof prefixConfig === 'string') {
        prefix = prefixConfig
      }

      const lines = ['🎨 图像生成指令列表：\n']

      // 遍历用户指令
      commandRegistry.userCommands
        .filter(cmd => config.showQuotaInImageCommands || cmd.name !== COMMANDS.QUERY_QUOTA)
        .forEach(cmd => {
          lines.push(`${prefix}${cmd.name} - ${cmd.description}`)
        })

      return lines.join('\n')
    })

  const providerLabel = (config.provider as ProviderType) === 'gptgod' ? 'GPTGod' : '云雾 Gemini 2.5 Flash Image'
  logger.info(`aka-ai-generator 插件已启动 (${providerLabel})`)
}
