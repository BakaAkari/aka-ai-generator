import { Context, Schema, h, Session } from 'koishi'
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
  FUNCTION_LIST: '图像功能'
} as const

export type ImageProvider = 'yunwu' | 'gptgod'

export interface StyleConfig {
  commandName: string
  commandDescription: string
  prompt: string
  enabled: boolean
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
  apiTimeout: number
  commandTimeout: number
  defaultNumImages: number
  dailyFreeLimit: number
  rateLimitWindow: number
  rateLimitMax: number
  adminUsers: string[]
  styles: StyleConfig[]
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
    styles: Schema.array(Schema.object({
      commandName: Schema.string().required().description('命令名称（不含前缀斜杠）'),
      commandDescription: Schema.string().required().description('命令描述'),
      prompt: Schema.string().role('textarea', { rows: 4 }).required().description('生成 prompt'),
      enabled: Schema.boolean().default(true).description('是否启用此命令')
    })).role('table').default([
      {
        commandName: '变手办',
        commandDescription: '转换为手办风格',
        prompt: '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内',
        enabled: true
      },
      {
        commandName: '变写实',
        commandDescription: '以真实摄影风格重建主体',
        prompt: '请根据用户提供的图片，在严格保持主体身份、外观特征与姿态不变的前提下，生成一张照片级真实感的超写实摄影作品。要求：1. 采用专业相机拍摄（如佳能EOS R5），使用85mm f/1.4人像镜头，呈现柯达Portra 400胶片质感，8K超高清画质，HDR高动态范围，电影级打光效果；2. 画面应具有照片级真实感、超现实主义风格和高细节表现，确保光影、皮肤质感、服饰纹理与背景环境都贴近真实世界；3. 使用自然光影营造真实氛围，呈现raw and natural的原始自然感，具有authentic film snapshot的真实胶片质感，使用strong contrast between light and dark营造强烈明暗对比，产生deep shadows深阴影效果；4. 整体需具备tactile feel触感质感和simulated texture模拟纹理细节，可以适度优化噪点与瑕疵，但不要改变主体特征或添加额外元素；5. 整体效果需像专业摄影棚拍摄的真实照片，具有电影级画质；6. 如果主体是人物脸部，脸部生成效果应参考欧美混血白人精致美丽帅气英俊的外观特征进行生成，保持精致立体的五官轮廓、健康光泽的肌肤质感、优雅的气质和自然的表情，确保面部特征协调美观。',
        enabled: true
      },
      {
        commandName: '角色设定',
        commandDescription: '生成人物角色设定',
        prompt: '为我生成人物的角色设定（Character Design）, 比例设定（不同身高对比、头身比等）, 三视图（正面、侧面、背面）, 表情设定（Expression Sheet） , 动作设定（Pose Sheet） → 各种常见姿势, 服装设定（Costume Design）',
        enabled: true
      },
      {
        commandName: '道具设定',
        commandDescription: '生成游戏道具设定（武器、载具等）',
        prompt: '为我生成游戏道具的完整设定（Prop/Item Design），包含以下内容：功能结构图（Functional Components）、状态变化展示（State Variations）、细节特写（Detail Close-ups）',
        enabled: true
      }
    ]).description('自定义风格命令配置')
  })
])

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-ai-generator')
  const activeTasks = new Map<string, string>()  // userId -> requestId
  const rateLimitMap = new Map<string, number[]>()  // userId -> timestamps
  
  // 创建图像生成供应商
  const imageProvider: IImageProvider = createImageProvider({
    provider: config.provider as ProviderType,
    yunwuApiKey: config.yunwuApiKey,
    yunwuModelId: config.yunwuModelId,
    gptgodApiKey: config.gptgodApiKey,
    gptgodModelId: config.gptgodModelId,
    apiTimeout: config.apiTimeout,
    logLevel: config.logLevel,
    logger,
    ctx
  })
  
  // 获取动态风格指令
  function getStyleCommands() {
    if (!config.styles || !Array.isArray(config.styles)) return []
    return config.styles
      .filter(style => style.enabled && style.commandName && style.prompt)
      .map(style => ({
        name: style.commandName,
        description: style.commandDescription || '图像风格转换'
      }))
  }

  // 指令管理系统
  const commandRegistry = {
    // 非管理员指令（包含动态风格指令）
    userCommands: [
      ...getStyleCommands(),
      { name: COMMANDS.GENERATE_IMAGE, description: '使用自定义prompt进行图像处理' },
      { name: COMMANDS.COMPOSE_IMAGE, description: '合成多张图片，使用自定义prompt控制合成效果' },
      { name: COMMANDS.CHANGE_POSE, description: '改变图像主体的姿势造型，保持主体细节和风格不变' },
      { name: COMMANDS.OPTIMIZE_DESIGN, description: '修改图像主体的结构设计，保持原有设计语言和风格' },
      { name: COMMANDS.PIXELATE, description: '将图像主体转换为8位像素艺术风格' },
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
  async function checkDailyLimit(userId: string): Promise<{ allowed: boolean, message?: string, isAdmin?: boolean }> {
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
      return { allowed: true, isAdmin: false }
    }
    
    const today = new Date().toDateString()
    const lastReset = new Date(userData.lastDailyReset || userData.createdAt).toDateString()
    
    // 如果是新的一天，重置每日计数（延迟写入，仅在真正使用时写入）
    if (today !== lastReset) {
      userData.dailyUsageCount = 0
      userData.lastDailyReset = new Date().toISOString()
      // 不立即写入，等待 updateUserData 时一起写入
    }
    
    // 检查每日免费次数
    if (userData.dailyUsageCount < config.dailyFreeLimit) {
      return { allowed: true, isAdmin: false }
    }
    
    // 检查充值次数
    if (userData.remainingPurchasedCount > 0) {
      return { allowed: true, isAdmin: false }
    }
    
    return { 
      allowed: false, 
      message: `今日免费次数已用完（${config.dailyFreeLimit}次），充值次数也已用完。请联系管理员充值或明天再试`,
      isAdmin: false
    }
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
  async function updateUserData(userId: string, userName: string, commandName: string): Promise<{ userData: UserData, consumptionType: 'free' | 'purchased' }> {
    const usersData = await loadUsersData()
    const now = new Date().toISOString()
    const today = new Date().toDateString()
    
    if (!usersData[userId]) {
      // 创建新用户数据，使用userId作为用户名
      usersData[userId] = {
        userId,
        userName: userId,
        totalUsageCount: 1,
        dailyUsageCount: 1,
        lastDailyReset: now,
        purchasedCount: 0,
        remainingPurchasedCount: 0,
        donationCount: 0,
        donationAmount: 0,
        lastUsed: now,
        createdAt: now
      }
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'free' }
    }
    
    // 更新现有用户数据
    // 不更新用户名，保持原有用户名
    usersData[userId].totalUsageCount += 1
    usersData[userId].lastUsed = now
    
    // 检查是否需要重置每日计数
    const lastReset = new Date(usersData[userId].lastDailyReset || usersData[userId].createdAt).toDateString()
    if (today !== lastReset) {
      usersData[userId].dailyUsageCount = 0
      usersData[userId].lastDailyReset = now
    }
    
    // 优先消耗每日免费次数
    if (usersData[userId].dailyUsageCount < config.dailyFreeLimit) {
      usersData[userId].dailyUsageCount += 1
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'free' }
    }
    
    // 消耗充值次数
    if (usersData[userId].remainingPurchasedCount > 0) {
      usersData[userId].remainingPurchasedCount -= 1
      await saveUsersData(usersData)
      return { userData: usersData[userId], consumptionType: 'purchased' }
    }
    
    // 理论上不应该到达这里，因为checkDailyLimit已经检查过了
    await saveUsersData(usersData)
    return { userData: usersData[userId], consumptionType: 'free' }
  }

  // 记录用户调用次数并发送统计信息（仅在成功时调用）
  async function recordUserUsage(session: Session, commandName: string) {
    const userId = session.userId
    const userName = session.username || session.userId || '未知用户'
    
    if (!userId) return
    
    // 更新限流记录
    updateRateLimit(userId)
    
    // 更新用户数据
    const { userData, consumptionType } = await updateUserData(userId, userName, commandName)
    
    // 发送统计信息
    if (isAdmin(userId)) {
      await session.send(`📊 使用统计 [管理员]\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`)
    } else {
      const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
      const consumptionText = consumptionType === 'free' ? '每日免费次数' : '充值次数'
      await session.send(`📊 使用统计\n用户：${userData.userName}\n本次消费：${consumptionText} -1\n总调用次数：${userData.totalUsageCount}次\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次`)
    }
    
    logger.info('用户调用记录', { 
      userId, 
      userName: userData.userName, 
      commandName, 
      totalUsageCount: userData.totalUsageCount,
      dailyUsageCount: userData.dailyUsageCount,
      remainingPurchasedCount: userData.remainingPurchasedCount,
      consumptionType,
      isAdmin: isAdmin(userId)
    })
  }


  // 获取图片URL（三种方式）
  async function getImageUrl(img: any, session: Session): Promise<string | null> {
    let url: string | null = null
    
    // 方法1：从命令参数获取图片
    if (img) {
      url = img.attrs?.src || null
      if (url) {
        if (config.logLevel === 'debug') {
          logger.debug('从命令参数获取图片', { url })
        }
        return url
      }
    }
    
    // 方法2：从引用消息获取图片
    let elements = session.quote?.elements
    if (elements) {
      const images = h.select(elements, 'img')
      if (images.length > 0) {
        // 检查是否有多张图片
        if (images.length > 1) {
          await session.send('本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图像"命令')
          return null
        }
        url = images[0].attrs.src
        if (config.logLevel === 'debug') {
          logger.debug('从引用消息获取图片', { url })
        }
        return url
      }
    }
    
    // 方法3：等待用户发送图片
    await session.send('请在30秒内发送一张图片')
    const msg = await session.prompt(30000)
    
    if (!msg) {
      await session.send('等待超时')
      return null
    }
    
    // 解析用户发送的消息
    elements = h.parse(msg)
    const images = h.select(elements, 'img')
    
    if (images.length === 0) {
      await session.send('未检测到图片，请重试')
      return null
    }
    
    // 检查是否有多张图片
    if (images.length > 1) {
      await session.send('本功能仅支持处理一张图片，检测到多张图片。如需合成多张图片请使用"合成图像"命令')
      return null
    }
    
    url = images[0].attrs.src
    if (config.logLevel === 'debug') {
      logger.debug('从用户输入获取图片', { url })
    }
    return url
  }

  // 使用供应商生成图像
  async function requestProviderImages(prompt: string, imageUrls: string | string[], numImages: number): Promise<string[]> {
    return await imageProvider.generateImages(prompt, imageUrls, numImages)
  }

  // 带超时的通用图像处理函数
  async function processImageWithTimeout(session: any, img: any, prompt: string, styleName: string, numImages?: number) {
    return Promise.race([
      processImage(session, img, prompt, styleName, numImages),
      new Promise<string>((_, reject) => 
        setTimeout(() => reject(new Error('命令执行超时')), config.commandTimeout * 1000)
      )
    ]).catch(error => {
      const userId = session.userId
      if (userId) activeTasks.delete(userId)
      logger.error('图像处理超时或失败', { userId, error })
      return error.message === '命令执行超时' ? '图像处理超时，请重试' : '图像处理失败，请稍后重试'
    })
  }

  // 通用图像处理函数
  async function processImage(session: any, img: any, prompt: string, styleName: string, numImages?: number) {
    const userId = session.userId
    
    // 检查是否已有任务进行
    if (activeTasks.has(userId)) {
      return '您有一个图像处理任务正在进行中，请等待完成'
    }
    
    // 获取参数
    const imageCount = numImages || config.defaultNumImages
    
    // 验证参数
    if (imageCount < 1 || imageCount > 4) {
      return '生成数量必须在 1-4 之间'
    }
    
    // 获取图片URL
    const imageUrl = await getImageUrl(img, session)
    if (!imageUrl) {
      return  // 错误信息已在 getImageUrl 中发送
    }
    
    logger.info('开始图像处理', { 
      userId, 
      imageUrl, 
      styleName,
      prompt, 
      numImages: imageCount 
    })
    
    // 调用图像编辑API
    await session.send(`开始处理图片（${styleName}）...`)
    
    try {
      activeTasks.set(userId, 'processing')
      
      const images = await requestProviderImages(prompt, imageUrl, imageCount)
      
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
      
      // 成功处理图片后记录使用统计
      await recordUserUsage(session, styleName)
      
      activeTasks.delete(userId)
      
    } catch (error: any) {
      activeTasks.delete(userId)
      logger.error('图像处理失败', { userId, error })
      
      // 如果是明确的错误信息（如内容策略拦截），直接返回
      if (error?.message && (
        error.message.includes('内容被安全策略拦截') ||
        error.message.includes('生成失败') ||
        error.message.includes('处理失败')
      )) {
        return error.message
      }
      
      // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
      return '图像处理失败，请稍后重试'
    }
  }


  // 动态注册风格命令
  if (config.styles && Array.isArray(config.styles)) {
    for (const style of config.styles) {
      if (style.enabled && style.commandName && style.prompt) {
        ctx.command(`${style.commandName} [img:text]`, style.commandDescription || '图像风格转换')
          .option('num', '-n <num:number> 生成图片数量 (1-4)')
          .action(async ({ session, options }, img) => {
            if (!session?.userId) return '会话无效'
            
            // 检查每日调用限制
            const limitCheck = await checkDailyLimit(session.userId!)
            if (!limitCheck.allowed) {
              return limitCheck.message
            }
            
            return processImageWithTimeout(session, img, style.prompt, style.commandName, options?.num)
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
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
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
          
          const imageUrl = collectedImages[0]
          const imageCount = options?.num || config.defaultNumImages
          
          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
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
            
            // 成功处理图片后记录使用统计
            await recordUserUsage(session, COMMANDS.GENERATE_IMAGE)
            
            activeTasks.delete(userId)
            
          } catch (error: any) {
            activeTasks.delete(userId)
            logger.error('自定义图像处理失败', { userId, error })
            
            // 如果是明确的错误信息（如内容策略拦截），直接返回
            if (error?.message && (
              error.message.includes('内容被安全策略拦截') ||
              error.message.includes('生成失败') ||
              error.message.includes('处理失败')
            )) {
              return error.message
            }
            
            // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
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
        return error.message === '命令执行超时' ? '图像处理超时，请重试' : '图像处理失败，请稍后重试'
      })
    })

  // 合成图像命令（多张图片合成）
  ctx.command(COMMANDS.COMPOSE_IMAGE, '合成多张图片，使用自定义prompt控制合成效果')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }) => {
      if (!session?.userId) return '会话无效'
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
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
          
          const imageCount = options?.num || config.defaultNumImages
          
          // 验证参数
          if (imageCount < 1 || imageCount > 4) {
            return '生成数量必须在 1-4 之间'
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
            
            // 成功处理图片后记录使用统计
            await recordUserUsage(session, COMMANDS.COMPOSE_IMAGE)
            
            activeTasks.delete(userId)
            
          } catch (error: any) {
            activeTasks.delete(userId)
            logger.error('图片合成失败', { userId, error })
            
            // 如果是明确的错误信息（如内容策略拦截），直接返回
            if (error?.message && (
              error.message.includes('内容被安全策略拦截') ||
              error.message.includes('生成失败') ||
              error.message.includes('处理失败')
            )) {
              return error.message
            }
            
            // 不返回具体错误信息，避免泄露API密钥或其他敏感信息
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
        return error.message === '命令执行超时' ? '图片合成超时，请重试' : '图片合成失败，请稍后重试'
      })
    })

  // 改姿势命令
  ctx.command(`${COMMANDS.CHANGE_POSE} [img:text]`, '改变图像主体的姿势造型，保持主体细节和风格不变')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
      // 改姿势的prompt，强调保持主体细节和风格，只改变姿势
      const posePrompt = '请根据用户提供的图片，在严格保持主体身份、外观特征、服装细节、艺术风格和整体氛围不变的前提下，生成一个新的姿势造型。新姿势应该更加帅气、可爱、有张力或符合主体内容的动态感，展现出更好的视觉表现力。要求：1. 完全保持主体的面部特征、发型、服装、配饰等所有细节不变；2. 完全保持原有的艺术风格（如二次元、写实、手绘等）不变；3. 只改变身体的姿势、动作和姿态，让主体看起来更有活力和表现力；4. 姿势应该自然、协调，符合主体的身份和性格特征；5. 保持背景环境的基本风格不变（可以适当调整视角或构图）。'
      
      return processImageWithTimeout(session, img, posePrompt, COMMANDS.CHANGE_POSE, options?.num)
    })

  // 修改设计命令
  ctx.command(`${COMMANDS.OPTIMIZE_DESIGN} [img:text]`, '修改图像主体的结构设计，保持原有设计语言和风格')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
      // 修改设计的prompt，强调保持原有设计语言，合理修改结构设计
      const designPrompt = '请根据用户提供的图片，在严格保持原有设计语言、视觉风格、功能特征和整体主题不变的前提下，对图像主体的结构设计进行修改。要求：1. 完全保持原有的设计语言和视觉风格（如现代简约、复古、科幻、奇幻等）不变；2. 保持主体的核心功能特征和身份定位不变；3. 可以合理且美观地添加、删改或修改结构元素（如装饰细节、功能组件、线条轮廓、比例关系等），使设计更加完善和美观；4. 所有修改必须符合原有主题的视觉风格，增强设计美感而不破坏原有设计语言；5. 修改后的设计应该更加协调、统一，具有更好的视觉层次和设计完整性；6. 保持色彩方案、材质质感和整体氛围的一致性。'
      
      return processImageWithTimeout(session, img, designPrompt, COMMANDS.OPTIMIZE_DESIGN, options?.num)
    })

  // 变像素命令
  ctx.command(`${COMMANDS.PIXELATE} [img:text]`, '将图像主体转换为8位像素艺术风格')
    .option('num', '-n <num:number> 生成图片数量 (1-4)')
    .action(async ({ session, options }, img) => {
      if (!session?.userId) return '会话无效'
      
      // 检查每日调用限制
      const limitCheck = await checkDailyLimit(session.userId)
      if (!limitCheck.allowed) {
        return limitCheck.message
      }
      
      // 变像素的prompt，将主体转换为8位像素艺术风格
      const pixelPrompt = '请根据用户提供的图片，将图像主体转换为经典的8位像素艺术风格。要求：1. 完全保持主体的身份、外观特征和核心识别元素不变，确保转换后仍然清晰可识别；2. 采用极简的8位像素风格，使用有限的复古调色板（通常为16-256色），营造经典街机游戏的美学氛围；3. 所有细节都进行像素化处理，使用清晰的像素块和锐利的边缘，避免平滑渐变；4. 采用干净的块状形式，保持简单、标志性的设计，突出主体的核心特征；5. 背景可以简化为纯色背景（如纯白或纯黑），或者保持简单的像素化背景，确保主体突出；6. 整体风格应具有强烈的复古游戏感，让人联想到经典街机游戏和早期电子游戏的视觉美学；7. 保持主体的比例和基本结构，但用像素块重新诠释所有细节。'
      
      return processImageWithTimeout(session, img, pixelPrompt, COMMANDS.PIXELATE, options?.num)
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

  const providerLabel = (config.provider as ProviderType) === 'gptgod' ? 'GPTGod' : '云雾 Gemini 2.5 Flash Image'
  logger.info(`aka-ai-generator 插件已启动 (${providerLabel})`)
}
