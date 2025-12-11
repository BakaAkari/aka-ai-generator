import { Context, Schema, h, Session, Argv } from 'koishi'
import { createImageProvider, ProviderType } from './providers'
import { sanitizeError, sanitizeString } from './providers/utils'
import { UserManager, RechargeRecord } from './services/UserManager'
import { parseStyleCommandModifiers, buildModelMappingIndex } from './utils/parser'
import { join } from 'path'

export const name = 'aka-ai-generator'

// 命令名称常量
const COMMANDS = {
  IMG_TO_IMG: '图生图',
  TXT_TO_IMG: '文生图',
  COMPOSE_IMAGE: '合成图',
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
  prompt: string
}

export interface StyleGroupConfig {
  prompts: StyleConfig[]
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
  dailyFreeLimit: number
  rateLimitWindow: number
  rateLimitMax: number
  adminUsers: string[]
  styles: StyleConfig[]
  styleGroups?: Record<string, StyleGroupConfig>
  logLevel: 'info' | 'debug'
  securityBlockWindow: number
  securityBlockWarningThreshold: number
}

const StyleItemSchema = Schema.object({
  commandName: Schema.string().required().description('命令名称').role('table-cell', { width: 100 }),
  prompt: Schema.string().role('textarea', { rows: 4 }).required().description('生成 prompt')
})

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    provider: Schema.union([
      Schema.const('yunwu').description('云雾 Gemini 服务'),
      Schema.const('gptgod').description('GPTGod 服务'),
      Schema.const('gemini').description('Google Gemini 原生'),
    ] as const)
      .default('yunwu' as ImageProvider)
      .description('图像生成供应商'),
    yunwuApiKey: Schema.string().description('云雾API密钥').role('secret').required(),
    yunwuModelId: Schema.string().default('gemini-2.5-flash-image').description('云雾图像生成模型ID'),
    gptgodApiKey: Schema.string().description('GPTGod API 密钥').role('secret').default(''),
    gptgodModelId: Schema.string().default('nano-banana').description('GPTGod 模型ID'),
    geminiApiKey: Schema.string().description('Gemini API 密钥').role('secret').default(''),
    geminiModelId: Schema.string().default('gemini-2.5-flash').description('Gemini 模型ID'),
    geminiApiBase: Schema.string().default('https://generativelanguage.googleapis.com').description('Gemini API 基础地址'),
    modelMappings: Schema.array(Schema.object({
      suffix: Schema.string().required().description('指令后缀（例如 4K，对应输入 -4K）'),
      provider: Schema.union([
        Schema.const('yunwu').description('云雾 Gemini 服务'),
        Schema.const('gptgod').description('GPTGod 服务'),
        Schema.const('gemini').description('Google Gemini 原生'),
      ] as const).description('可选：覆盖供应商'),
      modelId: Schema.string().required().description('触发该后缀时使用的模型 ID')
    })).role('table').default([]).description('根据 -后缀切换模型/供应商'),
    apiTimeout: Schema.number().default(120).description('API请求超时时间（秒）'),
    commandTimeout: Schema.number().default(180).description('命令执行总超时时间（秒）'),

    // 默认设置
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .description('默认生成图片数量'),

    // 配额设置
    dailyFreeLimit: Schema.number()
      .default(5)
      .min(1)
      .max(100)
      .description('每日免费调用次数'),

    // 限流设置
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

    // 管理员设置
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户ID列表（不受每日使用限制）'),

    // 日志级别设置
    logLevel: Schema.union([
      Schema.const('info').description('普通信息'),
      Schema.const('debug').description('完整的debug信息'),
    ] as const)
      .default('info' as const)
      .description('日志输出详细程度'),

    // 安全策略拦截设置
    securityBlockWindow: Schema.number()
      .default(600)
      .min(60)
      .max(3600)
      .description('安全策略拦截追踪时间窗口（秒），在此时间窗口内连续触发拦截会被记录'),
    securityBlockWarningThreshold: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .description('安全策略拦截警示阈值，连续触发此次数拦截后将发送警示消息，再次触发将被扣除积分')
  }),

  // 自定义风格命令配置
  Schema.object({
    styles: Schema.array(StyleItemSchema).role('table').default([
      {
        commandName: '变手办',
        prompt: '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内'
      },
      {
        commandName: '变写实',
        prompt: '请根据用户提供的图片，在严格保持主体身份、外观特征与姿态不变的前提下，生成一张照片级真实感的超写实摄影作品。要求：1. 采用专业相机拍摄（如佳能EOS R5），使用85mm f/1.4人像镜头，呈现柯达Portra 400胶片质感，8K超高清画质，HDR高动态范围，电影级打光效果；2. 画面应具有照片级真实感、超现实主义风格和高细节表现，确保光影、皮肤质感、服饰纹理与背景环境都贴近真实世界；3. 使用自然光影营造真实氛围，呈现raw and natural的原始自然感，具有authentic film snapshot的真实胶片质感；4. 整体需具备tactile feel触感质感和simulated texture模拟纹理细节，可以适度优化噪点与瑕疵，但不要改变主体特征或添加额外元素；5. 整体效果需像专业摄影棚拍摄的真实照片，具有电影级画质；6. 如果主体是人物脸部，脸部生成效果应参考欧美混血白人精致美丽帅气英俊的外观特征进行生成，保持精致立体的五官轮廓、健康光泽的肌肤质感、优雅的气质和自然的表情，确保面部特征协调美观。'
      },
    ]).description('自定义风格命令配置')
  }),
  Schema.object({
    styleGroups: Schema.dict(Schema.object({
      prompts: Schema.array(StyleItemSchema)
        .role('table')
        .default([])
        .description('属于该类型的 prompt 列表')
    })).role('table').default({}).description('按类型管理的 prompt 组，键名即为分组名称')
  })
])

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
        description: style.groupName ? `图像风格转换（${style.groupName}）` : '图像风格转换'
      }))
  }

  // 指令管理系统
  const commandRegistry = {
    // 非管理员指令（包含动态风格指令）
    userCommands: [
      ...getStyleCommands(),
      { name: COMMANDS.TXT_TO_IMG, description: '根据文字描述生成图像' },
      { name: COMMANDS.IMG_TO_IMG, description: '使用自定义prompt进行图像处理（图生图）' },
      { name: COMMANDS.COMPOSE_IMAGE, description: '合成多张图片，使用自定义prompt控制合成效果' },
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

  // 记录用户调用次数并发送统计信息（仅在成功时调用）
  async function recordUserUsage(session: Session, commandName: string, numImages: number = 1) {
    const userId = session.userId
    const userName = session.username || session.userId || '未知用户'
    if (!userId) return

    // 扣减额度
    const { userData, consumptionType, freeUsed, purchasedUsed } = await userManager.consumeQuota(userId, userName, commandName, numImages, config)

    // 发送统计信息
    if (userManager.isAdmin(userId, config)) {
      await session.send(`📊 使用统计 [管理员]\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`)
    } else {
      const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
      
      let consumptionText = ''
      if (consumptionType === 'mixed') {
        consumptionText = `每日免费次数 -${freeUsed}，充值次数 -${purchasedUsed}`
      } else if (consumptionType === 'free') {
        consumptionText = `每日免费次数 -${freeUsed}`
      } else {
        consumptionText = `充值次数 -${purchasedUsed}`
      }
      
      await session.send(`📊 使用统计\n用户：${userData.userName}\n本次生成：${numImages}张图片\n本次消费：${consumptionText}\n总调用次数：${userData.totalUsageCount}次\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次`)
    }

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
      isAdmin: userManager.isAdmin(userId, config)
    })
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

      const elements = h.parse(msg)
      const images = h.select(elements, 'img')
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

  // 使用供应商生成图像
  async function requestProviderImages(prompt: string, imageUrls: string | string[], numImages: number, requestContext?: ImageRequestContext): Promise<string[]> {
    const providerType = (requestContext?.provider || config.provider) as ProviderType
    const targetModelId = requestContext?.modelId
    const providerInstance = getProviderInstance(providerType, targetModelId)
    if (config.logLevel === 'debug') {
      logger.debug('准备调用图像供应商', {
        providerType,
        modelId: targetModelId || 'default',
        numImages
      })
    }
    return await providerInstance.generateImages(prompt, imageUrls, numImages)
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
      if (userId) userManager.endTask(userId)
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

        const images = await requestProviderImages(finalPrompt, imageUrls, imageCount, requestContext)
        
        if (checkTimeout && checkTimeout()) throw new Error('命令执行超时')

        if (images.length === 0) {
          return '图像处理失败：未能生成图片'
        }

        // 成功处理图片后记录使用统计（按实际生成的图片数量计费）
        // 提前记录，防止发送图片过程中因适配器无响应导致统计失败
        await recordUserUsage(session, styleName, images.length)

        await session.send('图像处理完成！')

        // 发送生成的图片
        for (let i = 0; i < images.length; i++) {
          if (checkTimeout && checkTimeout()) break // 中断发送
          
          try {
            // 给图片发送增加独立超时(20s)，防止适配器无响应导致任务挂起
            await Promise.race([
              session.send(h.image(images[i])),
              new Promise((_, reject) => setTimeout(() => reject(new Error('SendTimeout')), 20000))
            ])
          } catch (err) {
             // 仅记录警告，不中断流程，因为图片可能已经发出去了只是没收到回包
             logger.warn(`图片发送可能超时 (用户: ${userId}): ${err instanceof Error ? err.message : String(err)}`)
          }

          // 多张图片添加延时
          if (images.length > 1 && i < images.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000))
          }
        }

    } finally {
        userManager.endTask(userId)
    }
  }


  // 动态注册风格命令
  if (styleDefinitions.length > 0) {
    for (const style of styleDefinitions) {
      if (style.commandName && style.prompt) {
        ctx.command(`${style.commandName} [img:text]`, '图像风格转换')
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

            // 检查每日调用限制（传入实际要生成的图片数量）
            const limitCheck = await userManager.checkDailyLimit(session.userId!, config, numImages)
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

  // 文生图命令
  ctx.command(`${COMMANDS.TXT_TO_IMG} [prompt:text]`, '根据文字描述生成图像')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, prompt) => {
      if (!session?.userId) return '会话无效'
      const numImages = options?.num || config.defaultNumImages
      
      // 检查每日调用限制
      const limitCheck = await userManager.checkDailyLimit(session.userId!, config, numImages)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const requestContext: ImageRequestContext = {
        numImages: numImages
      }
      
      return processImageWithTimeout(session, prompt, '', COMMANDS.TXT_TO_IMG, requestContext, {}, 'text')
    })

  // 图生图命令（自定义prompt）
  ctx.command(`${COMMANDS.IMG_TO_IMG} [img:text]`, '使用自定义prompt进行图像处理')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .option('multiple', '-m 允许多图输入')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      const numImages = options?.num || config.defaultNumImages
      const mode = options?.multiple ? 'multiple' : 'single'

      // 检查每日调用限制
      const limitCheck = await userManager.checkDailyLimit(session.userId!, config, numImages)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }

      const requestContext: ImageRequestContext = {
        numImages: numImages
      }

      // 使用通用处理函数，prompt 为空字符串，让其通过交互或 img 参数获取
      return processImageWithTimeout(session, img, '', COMMANDS.IMG_TO_IMG, requestContext, {}, mode)
    })

  // 合成图命令（多张图片合成）
  ctx.command(COMMANDS.COMPOSE_IMAGE, '合成多张图片，使用自定义prompt控制合成效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'
      const userId = session.userId

      // 检查是否已有任务进行
      if (!userManager.startTask(userId)) {
        return '您有一个图像处理任务正在进行中，请等待完成'
      }

      // 需要手动释放任务锁，因为 processImageWithTimeout 内部也会加锁，这里为了复用逻辑需要特殊处理
      // 实际上这里因为需要自定义交互流程，不能直接复用 processImage 的前半部分
      // 简单的做法是：这里只做交互，获取到数据后，调用 processImageWithTimeout
      // 但 processImageWithTimeout 又会去获取输入数据，这会冲突
      
      // 修正：我们手动实现合成图的超时控制，不使用 processImageWithTimeout
      userManager.endTask(userId) // 先释放，下面重新加锁

      let isTimeout = false
      return Promise.race([
        (async () => {
          if (!userManager.startTask(userId)) return '您有一个图像处理任务正在进行中'

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

            // 检查每日调用限制（传入实际要生成的图片数量）
            const limitCheck = await userManager.checkDailyLimit(userId, config, imageCount)
            if (!limitCheck.allowed) {
              return limitCheck.message
            }
            
            if (isTimeout) throw new Error('命令执行超时')

            logger.info('开始图片合成处理', {
              userId,
              imageUrls: collectedImages,
              prompt,
              numImages: imageCount,
              imageCount: collectedImages.length
            })

            // 调用图像编辑API（支持多张图片）
            await session.send(`开始合成图（${collectedImages.length}张）...\nPrompt: ${prompt}`)

            const resultImages = await requestProviderImages(prompt, collectedImages, imageCount)
            
            if (isTimeout) throw new Error('命令执行超时')

            if (resultImages.length === 0) {
              return '图片合成失败：未能生成图片'
            }

            // 成功处理图片后记录使用统计（按实际生成的图片数量计费）
            // 提前记录，防止发送图片过程中因适配器无响应导致统计失败
            await recordUserUsage(session, COMMANDS.COMPOSE_IMAGE, resultImages.length)

            await session.send('图片合成完成！')

            // 发送生成的图片
            for (let i = 0; i < resultImages.length; i++) {
              if (isTimeout) break
              
              try {
                // 给图片发送增加独立超时(20s)，防止适配器无响应导致任务挂起
                await Promise.race([
                  session.send(h.image(resultImages[i])),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('SendTimeout')), 20000))
                ])
              } catch (err) {
                 logger.warn(`图片合成发送可能超时 (用户: ${userId}): ${err instanceof Error ? err.message : String(err)}`)
              }

              if (resultImages.length > 1 && i < resultImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }

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
        if (userId) userManager.endTask(userId)
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
      commandRegistry.userCommands.forEach(cmd => {
        lines.push(`${prefix}${cmd.name} - ${cmd.description}`)
      })

      return lines.join('\n')
    })

  const providerLabel = (config.provider as ProviderType) === 'gptgod' ? 'GPTGod' : '云雾 Gemini 2.5 Flash Image'
  logger.info(`aka-ai-generator 插件已启动 (${providerLabel})`)
}
