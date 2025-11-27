import { Context, Schema, h, Session, Argv } from 'koishi'
import { existsSync, mkdirSync, promises as fs } from 'fs'
import { join } from 'path'
import { createImageProvider, ImageProvider as IImageProvider, ProviderType } from './providers'

export const name = 'aka-ai-generator'

// 命令名称常量
const COMMANDS = {
  GENERATE_IMAGE: '生成图像',
  COMPOSE_IMAGE: '合成图像',
  CHANGE_POSE: '改姿势',
  OPTIMIZE_DESIGN: '修改设计',
  PIXELATE: '变像素',
  QUERY_QUOTA: '图像额度',
  RECHARGE: '图像充值',
  RECHARGE_HISTORY: '图像充值记录',
  FUNCTION_LIST: '图像功能',
  IMAGE_COMMANDS: '图像指令'
} as const

export type ImageProvider = 'yunwu' | 'gptgod'

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  provider?: ImageProvider
}

export interface StyleConfig {
  commandName: string
  prompt: string
  mode?: 'single' | 'multiple'
}

export interface StyleGroupConfig {
  prompts: StyleConfig[]
}

interface ResolvedStyleConfig extends StyleConfig {
  groupName?: string
}

interface StyleCommandModifiers {
  modelMapping?: ModelMappingConfig
  customPromptSuffix?: string
  customAdditions?: string[]
}

interface ImageRequestContext {
  numImages?: number
  provider?: ProviderType
  modelId?: string
}

// 用户数据接口
export interface UserData {
  userId: string
  userName: string
  totalUsageCount: number
  dailyUsageCount: number
  lastDailyReset: string
  purchasedCount: number           // 历史累计充值次数
  remainingPurchasedCount: number // 当前剩余充值次数
  donationCount: number
  donationAmount: number
  lastUsed: string
  createdAt: string
}

// 用户数据存储接口
export interface UsersData {
  [userId: string]: UserData
}

// 插件配置接口
export interface Config {
  provider: ImageProvider
  yunwuApiKey: string
  yunwuModelId: string
  gptgodApiKey: string
  gptgodModelId: string
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
}

// 充值记录接口
export interface RechargeRecord {
  id: string
  timestamp: string
  type: 'single' | 'batch'
  operator: {
    userId: string
    userName: string
  }
  targets: Array<{
    userId: string
    userName: string
    amount: number
    beforeBalance: number
    afterBalance: number
  }>
  totalAmount: number
  note: string
  metadata: Record<string, any>
}

// 充值历史数据接口
export interface RechargeHistory {
  version: string
  lastUpdate: string
  records: RechargeRecord[]
}

const StyleItemSchema = Schema.object({
  commandName: Schema.string().required().description('命令名称（不含前缀斜杠）'),
  prompt: Schema.string().role('textarea', { rows: 4 }).required().description('生成 prompt'),
  mode: Schema.union([
    Schema.const('single').description('单图模式'),
    Schema.const('multiple').description('多图模式')
  ]).default('single').description('图片输入模式')
})

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    provider: Schema.union([
      Schema.const('yunwu').description('云雾 Gemini 服务'),
      Schema.const('gptgod').description('GPTGod 服务'),
    ] as const)
      .default('yunwu' as ImageProvider)
      .description('图像生成供应商'),
    yunwuApiKey: Schema.string().description('云雾API密钥').role('secret').required(),
    yunwuModelId: Schema.string().default('gemini-2.5-flash-image').description('云雾图像生成模型ID'),
    gptgodApiKey: Schema.string().description('GPTGod API 密钥').role('secret').default(''),
    gptgodModelId: Schema.string().default('nano-banana').description('GPTGod 模型ID'),
    modelMappings: Schema.array(Schema.object({
      suffix: Schema.string().required().description('指令后缀（例如 4K，对应输入 -4K）'),
      provider: Schema.union([
        Schema.const('yunwu').description('云雾 Gemini 服务'),
        Schema.const('gptgod').description('GPTGod 服务'),
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
      .description('日志输出详细程度')
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
  const activeTasks = new Map<string, string>()  // userId -> requestId
  const rateLimitMap = new Map<string, number[]>()  // userId -> timestamps

  // 供应商缓存，按 provider + modelId 复用实例
  const providerCache = new Map<string, IImageProvider>()
  function getProviderInstance(providerType: ProviderType, modelId?: string): IImageProvider {
    const cacheKey = `${providerType}:${modelId || 'default'}`
    if (!providerCache.has(cacheKey)) {
      providerCache.set(cacheKey, createImageProvider({
        provider: providerType,
        yunwuApiKey: config.yunwuApiKey,
        yunwuModelId: providerType === 'yunwu' ? (modelId || config.yunwuModelId) : config.yunwuModelId,
        gptgodApiKey: config.gptgodApiKey,
        gptgodModelId: providerType === 'gptgod' ? (modelId || config.gptgodModelId) : config.gptgodModelId,
        apiTimeout: config.apiTimeout,
        logLevel: config.logLevel,
        logger,
        ctx
      }))
    }
    return providerCache.get(cacheKey)!
  }
  // 预热默认供应商
  getProviderInstance(config.provider as ProviderType)

  const modelMappingIndex = buildModelMappingIndex(config.modelMappings)

  function normalizeSuffix(value?: string) {
    return value?.replace(/^\-+/, '').trim().toLowerCase()
  }

  /**
   * 从 prompt 文本中解析生成图片数量
   * 支持的模式：生成X张、X张图片、生成 X 张、X张等
   * @param prompt 原始 prompt 文本
   * @returns { numImages: number | undefined, cleanedPrompt: string } 解析出的数量和清理后的 prompt
   */
  function parseNumImagesFromPrompt(prompt: string): { numImages: number | undefined, cleanedPrompt: string } {
    if (!prompt || typeof prompt !== 'string') {
      return { numImages: undefined, cleanedPrompt: prompt }
    }

    // 匹配模式：生成X张、X张图片、生成 X 张、X张等（X 为 1-4）
    const patterns = [
      /生成\s*([1-4])\s*张(?:图片)?/i,
      /([1-4])\s*张(?:图片)?/,
      /生成\s*([1-4])\s*个(?:图片)?/i,
      /([1-4])\s*个(?:图片)?/,
      /num[:\s]*([1-4])/i,
      /数量[:\s]*([1-4])/i
    ]

    let numImages: number | undefined = undefined
    let cleanedPrompt = prompt

    for (const pattern of patterns) {
      const match = prompt.match(pattern)
      if (match) {
        const num = parseInt(match[1], 10)
        if (num >= 1 && num <= 4) {
          numImages = num
          // 移除匹配到的文本，保留其他内容
          cleanedPrompt = prompt.replace(pattern, '').trim()
          // 清理多余的空格和标点
          cleanedPrompt = cleanedPrompt.replace(/\s+/g, ' ').replace(/[，,]\s*$/, '').trim()
          break
        }
      }
    }

    return { numImages, cleanedPrompt }
  }

  function buildModelMappingIndex(mappings?: ModelMappingConfig[]) {
    const map = new Map<string, ModelMappingConfig>()
    if (!Array.isArray(mappings)) return map
    for (const mapping of mappings) {
      const key = normalizeSuffix(mapping?.suffix)
      if (!key || !mapping?.modelId) continue
      map.set(key, mapping)
    }
    return map
  }

  function parseStyleCommandModifiers(argv: Argv, imgParam?: any): StyleCommandModifiers {
    // 优先从 session.content 解析原始文本，以支持被 Koishi 误吞的参数（如 -add, -4k）
    const session = argv.session
    let rawText = ''

    if (session?.content) {
      const elements = h.parse(session.content)
      // 提取所有文本节点
      rawText = h.select(elements, 'text').map(e => e.attrs.content).join(' ')
    }

    // 如果没有获取到 rawText，回退到原来的逻辑
    const argsList = rawText ? rawText.split(/\s+/).filter(Boolean) : [...(argv.args || [])].map(arg => typeof arg === 'string' ? arg.trim() : '').filter(Boolean)

    // 如果是回退逻辑，还需要处理 rest 和 imgParam
    if (!rawText) {
      const restStr = typeof argv.rest === 'string' ? argv.rest.trim() : ''
      if (restStr) {
        const restParts = restStr.split(/\s+/).filter(Boolean)
        argsList.push(...restParts)
      }

      if (imgParam && typeof imgParam === 'string' && !imgParam.startsWith('http') && !imgParam.startsWith('data:')) {
        const imgParts = imgParam.split(/\s+/).filter(Boolean)
        argsList.push(...imgParts)
      }
    }

    if (!argsList.length) return {}

    const modifiers: StyleCommandModifiers = { customAdditions: [] }
    const flagCandidates: string[] = []

    let index = 0
    while (index < argsList.length) {
      const token = argsList[index]
      if (!token) {
        index++
        continue
      }

      const lower = token.toLowerCase()

      // -prompt:xxx 形式
      if (lower.startsWith('-prompt:')) {
        const promptHead = token.substring(token.indexOf(':') + 1)
        const restTokens = argsList.slice(index + 1)
        modifiers.customPromptSuffix = [promptHead, ...restTokens].join(' ').trim()
        break
      }

      // -add <文本...> 追加用户自定义段
      if (lower === '-add') {
        index++
        const additionTokens: string[] = []
        // 读取直到下一个以 - 开头的 flag 或结束
        while (index < argsList.length) {
          const nextToken = argsList[index]
          // 如果是 flag (以 - 开头)，且不是 -add (防止重复)，且在 mapping 中存在或者是已知 flag
          // 这里简单判断：如果以 - 开头，且能在 mapping 中找到，或者是 -prompt，则停止
          // 但为了简单，只要是 - 开头就停止，除非是 -add 的参数本身包含 - (极少)
          if (nextToken.startsWith('-')) {
            // 检查是否是有效的 flag
            const key = normalizeSuffix(nextToken)
            if (key && modelMappingIndex.has(key)) break
            if (nextToken.toLowerCase().startsWith('-prompt:')) break
            if (nextToken.toLowerCase() === '-add') break
          }
          additionTokens.push(nextToken)
          index++
        }
        if (additionTokens.length) {
          modifiers.customAdditions!.push(additionTokens.join(' '))
        }
        continue
      }

      flagCandidates.push(token)
      index++
    }

    for (const arg of flagCandidates) {
      if (!arg.startsWith('-')) continue
      const key = normalizeSuffix(arg)
      if (!key) continue
      const mapping = modelMappingIndex.get(key)
      if (mapping) {
        modifiers.modelMapping = mapping
        break
      }
    }

    return modifiers
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
        description: style.groupName ? `图像风格转换（${style.groupName}）` : '图像风格转换'
      }))
  }

  // 指令管理系统
  const commandRegistry = {
    // 非管理员指令（包含动态风格指令）
    userCommands: [
      ...getStyleCommands(),
      { name: COMMANDS.GENERATE_IMAGE, description: '使用自定义prompt进行图像处理' },
      { name: COMMANDS.COMPOSE_IMAGE, description: '合成多张图片，使用自定义prompt控制合成效果' },
      { name: COMMANDS.QUERY_QUOTA, description: '查询用户额度信息' }
    ],
    // 管理员指令
    adminCommands: [
      { name: COMMANDS.RECHARGE, description: '为用户充值次数（仅管理员）' },
      { name: COMMANDS.RECHARGE_HISTORY, description: '查看充值历史记录（仅管理员）' }
    ]
  }

  // 数据文件路径
  const dataDir = './data/aka-ai-generator'
  const dataFile = join(dataDir, 'users_data.json')
  const backupFile = join(dataDir, 'users_data.json.backup')
  const rechargeHistoryFile = join(dataDir, 'recharge_history.json')

  // 确保数据目录存在
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  // 检查是否为管理员
  function isAdmin(userId: string): boolean {
    return config.adminUsers && config.adminUsers.includes(userId)
  }

  // 检查限流
  function checkRateLimit(userId: string): { allowed: boolean, message?: string } {
    const now = Date.now()
    const userTimestamps = rateLimitMap.get(userId) || []
    const windowStart = now - config.rateLimitWindow * 1000

    // 清理过期的时间戳
    const validTimestamps = userTimestamps.filter(timestamp => timestamp > windowStart)

    if (validTimestamps.length >= config.rateLimitMax) {
      return {
        allowed: false,
        message: `操作过于频繁，请${Math.ceil((validTimestamps[0] + config.rateLimitWindow * 1000 - now) / 1000)}秒后再试`
      }
    }

    return { allowed: true }
  }

  // 更新限流记录
  function updateRateLimit(userId: string): void {
    const now = Date.now()
    const userTimestamps = rateLimitMap.get(userId) || []
    userTimestamps.push(now)
    rateLimitMap.set(userId, userTimestamps)
  }

  // 检查用户每日调用限制
  async function checkDailyLimit(userId: string, numImages: number = 1): Promise<{ allowed: boolean, message?: string, isAdmin?: boolean }> {
    // 检查是否为管理员
    if (isAdmin(userId)) {
      return { allowed: true, isAdmin: true }
    }

    // 检查限流
    const rateLimitCheck = checkRateLimit(userId)
    if (!rateLimitCheck.allowed) {
      return { ...rateLimitCheck, isAdmin: false }
    }

    const usersData = await loadUsersData()
    const userData = usersData[userId]

    if (!userData) {
      // 新用户，检查是否有足够的免费次数
      if (numImages > config.dailyFreeLimit) {
        return {
          allowed: false,
          message: `生成 ${numImages} 张图片需要 ${numImages} 次可用次数，但您的可用次数不足（今日免费：${config.dailyFreeLimit}次，充值：0次）`,
          isAdmin: false
        }
      }
      return { allowed: true, isAdmin: false }
    }

    const today = new Date().toDateString()
    const lastReset = new Date(userData.lastDailyReset || userData.createdAt).toDateString()

    // 如果是新的一天，重置每日计数（延迟写入，仅在真正使用时写入）
    let dailyCount = userData.dailyUsageCount
    if (today !== lastReset) {
      dailyCount = 0
      userData.dailyUsageCount = 0
      userData.lastDailyReset = new Date().toISOString()
      // 不立即写入，等待 updateUserData 时一起写入
    }

    // 计算剩余次数
    const remainingToday = Math.max(0, config.dailyFreeLimit - dailyCount)
    const totalAvailable = remainingToday + userData.remainingPurchasedCount

    if (totalAvailable < numImages) {
      return {
        allowed: false,
        message: `生成 ${numImages} 张图片需要 ${numImages} 次可用次数，但您的可用次数不足（今日免费剩余：${remainingToday}次，充值剩余：${userData.remainingPurchasedCount}次，共${totalAvailable}次）`,
        isAdmin: false
      }
    }

    return { allowed: true, isAdmin: false }
  }

  // 通用输入获取函数
  async function getPromptInput(session: Session, message: string): Promise<string | null> {
    await session.send(message)
    const input = await session.prompt(30000) // 30秒超时
    return input || null
  }


  // 异步读取用户数据
  async function loadUsersData(): Promise<UsersData> {
    try {
      if (existsSync(dataFile)) {
        const data = await fs.readFile(dataFile, 'utf-8')
        return JSON.parse(data)
      }
    } catch (error) {
      logger.error('读取用户数据失败', error)
      // 尝试从备份恢复
      if (existsSync(backupFile)) {
        try {
          const backupData = await fs.readFile(backupFile, 'utf-8')
          logger.warn('从备份文件恢复用户数据')
          return JSON.parse(backupData)
        } catch (backupError) {
          logger.error('备份文件也损坏，使用空数据', backupError)
        }
      }
    }
    return {}
  }

  // 异步保存用户数据（带备份）
  async function saveUsersData(data: UsersData): Promise<void> {
    try {
      // 如果原文件存在，先备份
      if (existsSync(dataFile)) {
        await fs.copyFile(dataFile, backupFile)
      }

      // 写入新数据
      await fs.writeFile(dataFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
      logger.error('保存用户数据失败', error)
      throw error
    }
  }

  // 异步读取充值历史
  async function loadRechargeHistory(): Promise<RechargeHistory> {
    try {
      if (existsSync(rechargeHistoryFile)) {
        const data = await fs.readFile(rechargeHistoryFile, 'utf-8')
        return JSON.parse(data)
      }
    } catch (error) {
      logger.error('读取充值历史失败', error)
    }
    return {
      version: '1.0.0',
      lastUpdate: new Date().toISOString(),
      records: []
    }
  }

  // 异步保存充值历史
  async function saveRechargeHistory(history: RechargeHistory): Promise<void> {
    try {
      history.lastUpdate = new Date().toISOString()
      await fs.writeFile(rechargeHistoryFile, JSON.stringify(history, null, 2), 'utf-8')
    } catch (error) {
      logger.error('保存充值历史失败', error)
      throw error
    }
  }

  // 获取或创建用户数据
  async function getUserData(userId: string, userName: string): Promise<UserData> {
    const usersData = await loadUsersData()

    if (!usersData[userId]) {
      // 创建新用户数据
      usersData[userId] = {
        userId,
        userName,
        totalUsageCount: 0,
        dailyUsageCount: 0,
        lastDailyReset: new Date().toISOString(),
        purchasedCount: 0,
        remainingPurchasedCount: 0,
        donationCount: 0,
        donationAmount: 0,
        lastUsed: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
      await saveUsersData(usersData)
      logger.info('创建新用户数据', { userId, userName })
    }

    return usersData[userId]
  }

  // 更新用户数据（优先消耗免费次数）
  async function updateUserData(userId: string, userName: string, commandName: string, numImages: number = 1): Promise<{ userData: UserData, consumptionType: 'free' | 'purchased' | 'mixed', freeUsed: number, purchasedUsed: number }> {
    const usersData = await loadUsersData()
    const now = new Date().toISOString()
    const today = new Date().toDateString()

    if (!usersData[userId]) {
      // 创建新用户数据，使用userId作为用户名
      usersData[userId] = {
        userId,
        userName: userId,
        totalUsageCount: numImages,
        dailyUsageCount: numImages,
        lastDailyReset: now,
        purchasedCount: 0,
        remainingPurchasedCount: 0,
        donationCount: 0,
        donationAmount: 0,
        lastUsed: now,
        createdAt: now
      }
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'free', freeUsed: numImages, purchasedUsed: 0 }
    }

    // 更新现有用户数据
    // 不更新用户名，保持原有用户名
    usersData[userId].totalUsageCount += numImages
    usersData[userId].lastUsed = now

    // 检查是否需要重置每日计数
    const lastReset = new Date(usersData[userId].lastDailyReset || usersData[userId].createdAt).toDateString()
    if (today !== lastReset) {
      usersData[userId].dailyUsageCount = 0
      usersData[userId].lastDailyReset = now
    }

    // 计算需要消耗的次数
    let remainingToConsume = numImages
    let freeUsed = 0
    let purchasedUsed = 0

    // 优先消耗每日免费次数
    const availableFree = Math.max(0, config.dailyFreeLimit - usersData[userId].dailyUsageCount)
    if (availableFree > 0) {
      const freeToUse = Math.min(availableFree, remainingToConsume)
      usersData[userId].dailyUsageCount += freeToUse
      freeUsed = freeToUse
      remainingToConsume -= freeToUse
    }

    // 如果还有剩余，消耗充值次数
    if (remainingToConsume > 0) {
      const purchasedToUse = Math.min(usersData[userId].remainingPurchasedCount, remainingToConsume)
      usersData[userId].remainingPurchasedCount -= purchasedToUse
      purchasedUsed = purchasedToUse
      remainingToConsume -= purchasedToUse
    }

    await saveUsersData(usersData)

    // 确定消费类型
    let consumptionType: 'free' | 'purchased' | 'mixed'
    if (freeUsed > 0 && purchasedUsed > 0) {
      consumptionType = 'mixed'
    } else if (freeUsed > 0) {
      consumptionType = 'free'
    } else {
      consumptionType = 'purchased'
    }

    return { userData: usersData[userId], consumptionType, freeUsed, purchasedUsed }
  }

  // 记录用户调用次数并发送统计信息（仅在成功时调用）
  async function recordUserUsage(session: Session, commandName: string, numImages: number = 1) {
    const userId = session.userId
    const userName = session.username || session.userId || '未知用户'

    if (!userId) return

    // 更新限流记录
    updateRateLimit(userId)

    // 更新用户数据
    const { userData, consumptionType, freeUsed, purchasedUsed } = await updateUserData(userId, userName, commandName, numImages)

    // 发送统计信息
    if (isAdmin(userId)) {
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
      isAdmin: isAdmin(userId)
    })
  }


  // 获取输入数据（支持单图/多图）
  async function getInputData(session: Session, imgParam: any, mode: 'single' | 'multiple'): Promise<{ images: string[], text?: string } | { error: string }> {
    const collectedImages: string[] = []
    let collectedText = ''

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
          return { error: '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图像"命令' }
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
          await session.send('未检测到图片，请先发送图片')
          continue
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
  async function processImageWithTimeout(session: any, img: any, prompt: string, styleName: string, requestContext?: ImageRequestContext, displayInfo?: { customAdditions?: string[], modelId?: string, modelDescription?: string }, mode: 'single' | 'multiple' = 'single') {
    return Promise.race([
      processImage(session, img, prompt, styleName, requestContext, displayInfo, mode),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
      )
    ]).catch(error => {
      const userId = session.userId
      if (userId) activeTasks.delete(userId)
      logger.error('图像处理超时或失败', { userId, error })
      return error.message === '命令执行超时' ? '图像处理超时，请重试' : `图像处理失败：${error.message}`
    })
  }

  // 通用图像处理函数
  async function processImage(session: any, img: any, prompt: string, styleName: string, requestContext?: ImageRequestContext, displayInfo?: { customAdditions?: string[], modelId?: string, modelDescription?: string }, mode: 'single' | 'multiple' = 'single') {
    const userId = session.userId

    // 检查是否已有任务进行
    if (activeTasks.has(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }

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
    const { images: imageUrls, text: extraText } = inputResult

    // 如果在交互中提供了额外文本，追加到 prompt
    let finalPrompt = prompt
    if (extraText) {
      finalPrompt += ' ' + extraText
    }

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

    try {
      activeTasks.set(userId, 'processing')

      const images = await requestProviderImages(finalPrompt, imageUrls, imageCount, requestContext)

      if (images.length === 0) {
        activeTasks.delete(userId)
        return '图像处理失败：未能生成图片'
      }

      await session.send('图像处理完成！')

      // 发送生成的图片
      for (let i = 0; i < images.length; i++) {
        await session.send(h.image(images[i]))

        // 多张图片添加延时
        if (images.length > 1 && i < images.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      // 成功处理图片后记录使用统计（按实际生成的图片数量计费）
      await recordUserUsage(session, styleName, images.length)

      activeTasks.delete(userId)

    } catch (error: any) {
      activeTasks.delete(userId)
      logger.error('图像处理失败', { userId, error })

      // 直接返回错误信息，以便用户知道具体原因
      if (error?.message) {
        return `图像处理失败：${error.message}`
      }

      return '图像处理失败，请稍后重试'
    }
  }


  // 动态注册风格命令
  if (styleDefinitions.length > 0) {
    for (const style of styleDefinitions) {
      if (style.commandName && style.prompt) {
        ctx.command(`${style.commandName} [img:text]`, '图像风格转换')
          .option('num', '-n <num:number> 生成图片数量 (1-4)')
          .action(async (argv, img) => {
            const { session, options } = argv
            if (!session?.userId) return '会话无效'

            const modifiers = parseStyleCommandModifiers(argv, img)
            
            // 从用户自定义部分解析生成数量（不包括预设的 style.prompt）
            let userPromptParts: string[] = []
            if (modifiers.customAdditions?.length) {
              userPromptParts.push(...modifiers.customAdditions)
            }
            if (modifiers.customPromptSuffix) {
              userPromptParts.push(modifiers.customPromptSuffix)
            }
            const userPromptText = userPromptParts.join(' - ')
            
            // 从用户输入中解析数量
            let promptNumImages: number | undefined = undefined
            let cleanedUserPrompt = userPromptText
            if (userPromptText) {
              const parsed = parseNumImagesFromPrompt(userPromptText)
              if (parsed.numImages) {
                promptNumImages = parsed.numImages
                cleanedUserPrompt = parsed.cleanedPrompt
                if (config.logLevel === 'debug') {
                  logger.debug('从 prompt 中解析到生成数量', { numImages: promptNumImages, cleanedPrompt: cleanedUserPrompt })
                }
              }
            }
            
            // 确定要生成的图片数量
            const numImages = options?.num || promptNumImages || config.defaultNumImages

            // 检查每日调用限制（传入实际要生成的图片数量）
            const limitCheck = await checkDailyLimit(session.userId!, numImages)
            if (!limitCheck.allowed) {
              return limitCheck.message
            }
            
            // 构建最终的 prompt（保留预设的 style.prompt，使用清理后的用户输入）
            const promptSegments = [style.prompt]
            if (cleanedUserPrompt) {
              promptSegments.push(cleanedUserPrompt)
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

            const mode = style.mode || 'single'
            return processImageWithTimeout(session, img, mergedPrompt, style.commandName, requestContext, displayInfo, mode)
          })

        logger.info(`已注册命令: ${style.commandName}`)
      }
    }
  }

  // 生成图像命令（自定义prompt）
  ctx.command(COMMANDS.GENERATE_IMAGE, '使用自定义prompt进行图像处理')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'

      return Promise.race([
        (async () => {
          const userId = session.userId
          if (!userId) return '会话无效'

          // 检查是否已有任务进行
          if (activeTasks.has(userId)) {
            return '您有一个图像处理任务正在进行中，请等待完成'
          }

          // 等待用户发送图片和prompt
          await session.send('图片+描述')

          const collectedImages: string[] = []
          let prompt = ''

          // 循环接收消息，直到收到纯文字消息作为 prompt
          while (true) {
            const msg = await session.prompt(60000) // 60秒超时
            if (!msg) {
              return '等待超时，请重试'
            }

            const elements = h.parse(msg)
            const images = h.select(elements, 'img')
            const textElements = h.select(elements, 'text')
            const text = textElements.map(el => el.attrs.content).join(' ').trim()

            // 如果有图片，收集图片
            if (images.length > 0) {
              // 检查是否已经有图片
              if (collectedImages.length > 0) {
                return '本功能仅支持处理一张图片，如需合成多张图片请使用"合成图像"命令'
              }

              // 检查是否发送了多张图片
              if (images.length > 1) {
                return '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图像"命令'
              }

              for (const img of images) {
                collectedImages.push(img.attrs.src)
              }

              // 如果同时有文字，作为 prompt 并结束
              if (text) {
                prompt = text
                break
              }

              // 只有图片，继续等待
              await session.send('请发送描述')
              continue
            }

            // 如果只有文字
            if (text) {
              if (collectedImages.length === 0) {
                return '未检测到图片，请先发送图片'
              }
              prompt = text
              break
            }

            // 既没有图片也没有文字
            return '未检测到有效内容，请重新发送'
          }

          // 验证
          if (collectedImages.length === 0) {
            return '未检测到图片，请重新发送'
          }

          if (collectedImages.length > 1) {
            return '本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图像"命令'
          }

          if (!prompt) {
            return '未检测到prompt描述，请重新发送'
          }

          // 从 prompt 中解析生成数量
          const { numImages: promptNumImages, cleanedPrompt } = parseNumImagesFromPrompt(prompt)
          if (promptNumImages) {
            prompt = cleanedPrompt
            if (config.logLevel === 'debug') {
              logger.debug('从 prompt 中解析到生成数量', { numImages: promptNumImages, cleanedPrompt })
            }
          }

          const imageUrl = collectedImages[0]
          const imageCount = options?.num || promptNumImages || config.defaultNumImages

          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
          }

          // 检查每日调用限制（传入实际要生成的图片数量）
          const limitCheck = await checkDailyLimit(userId, imageCount)
          if (!limitCheck.allowed) {
            return limitCheck.message
          }

          logger.info('开始自定义图像处理', {
            userId,
            imageUrl,
            prompt,
            numImages: imageCount
          })

          // 调用图像编辑API
          await session.send(`开始处理图片（自定义prompt）...\nPrompt: ${prompt}`)

          try {
            activeTasks.set(userId, 'processing')

            const resultImages = await requestProviderImages(prompt, imageUrl, imageCount)

            if (resultImages.length === 0) {
              activeTasks.delete(userId)
              return '图像处理失败：未能生成图片'
            }

            await session.send('图像处理完成！')

            // 发送生成的图片
            for (let i = 0; i < resultImages.length; i++) {
              await session.send(h.image(resultImages[i]))

              if (resultImages.length > 1 && i < resultImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }

            // 成功处理图片后记录使用统计（按实际生成的图片数量计费）
            await recordUserUsage(session, COMMANDS.GENERATE_IMAGE, resultImages.length)

            activeTasks.delete(userId)

          } catch (error: any) {
            activeTasks.delete(userId)
            logger.error('自定义图像处理失败', { userId, error })

            // 直接返回错误信息
            if (error?.message) {
              return `图像处理失败：${error.message}`
            }

            return '图像处理失败，请稍后重试'
          }
        })(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
        )
      ]).catch(error => {
        const userId = session.userId
        if (userId) activeTasks.delete(userId)
        logger.error('自定义图像处理超时或失败', { userId, error })
        return error.message === '命令执行超时' ? '图像处理超时，请重试' : `图像处理失败：${error.message}`
      })
    })

  // 合成图像命令（多张图片合成）
  ctx.command(COMMANDS.COMPOSE_IMAGE, '合成多张图片，使用自定义prompt控制合成效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'

      return Promise.race([
        (async () => {
          const userId = session.userId
          if (!userId) return '会话无效'

          // 检查是否已有任务进行
          if (activeTasks.has(userId)) {
            return '您有一个图像处理任务正在进行中，请等待完成'
          }

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
            return '未检测到有效内容，请重新发送'
          }

          // 验证
          if (collectedImages.length < 2) {
            return '需要至少两张图片进行合成，请重新发送'
          }

          if (!prompt) {
            return '未检测到prompt描述，请重新发送'
          }

          // 从 prompt 中解析生成数量
          const { numImages: promptNumImages, cleanedPrompt } = parseNumImagesFromPrompt(prompt)
          if (promptNumImages) {
            prompt = cleanedPrompt
            if (config.logLevel === 'debug') {
              logger.debug('从 prompt 中解析到生成数量', { numImages: promptNumImages, cleanedPrompt })
            }
          }

          const imageCount = options?.num || promptNumImages || config.defaultNumImages

          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
          }

          // 检查每日调用限制（传入实际要生成的图片数量）
          const limitCheck = await checkDailyLimit(userId, imageCount)
          if (!limitCheck.allowed) {
            return limitCheck.message
          }

          logger.info('开始图片合成处理', {
            userId,
            imageUrls: collectedImages,
            prompt,
            numImages: imageCount,
            imageCount: collectedImages.length
          })

          // 调用图像编辑API（支持多张图片）
          await session.send(`开始合成图像（${collectedImages.length}张）...\nPrompt: ${prompt}`)

          try {
            activeTasks.set(userId, 'processing')

            const resultImages = await requestProviderImages(prompt, collectedImages, imageCount)

            if (resultImages.length === 0) {
              activeTasks.delete(userId)
              return '图片合成失败：未能生成图片'
            }

            await session.send('图片合成完成！')

            // 发送生成的图片
            for (let i = 0; i < resultImages.length; i++) {
              await session.send(h.image(resultImages[i]))

              if (resultImages.length > 1 && i < resultImages.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000))
              }
            }

            // 成功处理图片后记录使用统计（按实际生成的图片数量计费）
            await recordUserUsage(session, COMMANDS.COMPOSE_IMAGE, resultImages.length)

            activeTasks.delete(userId)

          } catch (error: any) {
            activeTasks.delete(userId)
            logger.error('图片合成失败', { userId, error })

            // 直接返回错误信息
            if (error?.message) {
              return `图片合成失败：${error.message}`
            }

            return '图片合成失败，请稍后重试'
          }
        })(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
        )
      ]).catch(error => {
        const userId = session.userId
        if (userId) activeTasks.delete(userId)
        logger.error('图片合成超时或失败', { userId, error })
        return error.message === '命令执行超时' ? '图片合成超时，请重试' : `图片合成失败：${error.message}`
      })
    })

  // 充值管理命令
  ctx.command(`${COMMANDS.RECHARGE} [content:text]`, '为用户充值次数（仅管理员）')
    .action(async ({ session }, content) => {
      if (!session?.userId) return '会话无效'

      // 检查管理员权限
      if (!isAdmin(session.userId)) {
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

        const usersData = await loadUsersData()
        const rechargeHistory = await loadRechargeHistory()
        const now = new Date().toISOString()
        const recordId = `recharge_${now.replace(/[-:T.]/g, '').slice(0, 14)}_${Math.random().toString(36).substr(2, 3)}`

        const targets = []

        // 为每个用户充值
        for (const userId of userIds) {
          if (!userId) continue // 跳过无效的userId

          // 获取被充值用户的用户名，优先使用已存储的用户名，否则使用userId
          let userName = userId
          if (usersData[userId]) {
            userName = usersData[userId].userName || userId
          }

          if (!usersData[userId]) {
            // 创建新用户，使用userId作为初始用户名
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
          // 不更新用户名，保持原有的用户名

          targets.push({
            userId,
            userName,
            amount,
            beforeBalance,
            afterBalance: usersData[userId].remainingPurchasedCount
          })
        }

        // 保存用户数据
        await saveUsersData(usersData)

        // 记录充值历史
        const record: RechargeRecord = {
          id: recordId,
          timestamp: now,
          type: userIds.length > 1 ? 'batch' : 'single',
          operator: {
            userId: session.userId,
            userName: session.username || session.userId
          },
          targets,
          totalAmount: amount * userIds.length,
          note: note || '管理员充值',
          metadata: {}
        }

        rechargeHistory.records.push(record)
        await saveRechargeHistory(rechargeHistory)

        const userList = targets.map(t => `${t.userName}(${t.afterBalance}次)`).join(', ')
        return `✅ 充值成功\n目标用户：${userList}\n充值次数：${amount}次/人\n总充值：${record.totalAmount}次\n操作员：${record.operator.userName}\n备注：${record.note}`

      } catch (error) {
        logger.error('充值操作失败', error)
        return '充值失败，请稍后重试'
      }
    })

  // 额度查询命令
  ctx.command(`${COMMANDS.QUERY_QUOTA} [target:text]`, '查询用户额度信息')
    .action(async ({ session }, target) => {
      if (!session?.userId) return '会话无效'

      const userIsAdmin = isAdmin(session.userId)
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
        const usersData = await loadUsersData()
        const userData = usersData[targetUserId]

        if (!userData) {
          return `👤 用户信息\n用户：${targetUserName}\n状态：新用户\n今日剩余免费：${config.dailyFreeLimit}次\n充值剩余：0次`
        }

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

      if (!isAdmin(session.userId)) {
        return '权限不足，仅管理员可查看充值记录'
      }

      try {
        const history = await loadRechargeHistory()
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
        const userIsAdmin = isAdmin(session.userId)

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
