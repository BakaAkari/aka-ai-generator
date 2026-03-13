import { existsSync, mkdirSync, promises as fs } from 'fs'
import { join } from 'path'
import { Config } from '../index'

// 简单的异步锁实现
class AsyncLock {
  private promise: Promise<void> = Promise.resolve()

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const previousPromise = this.promise
    let release: () => void

    const nextPromise = new Promise<void>((resolve) => {
      release = resolve
    })

    this.promise = nextPromise

    await previousPromise
    try {
      return await fn()
    } finally {
      release!()
    }
  }
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

// 充值记录接口
export interface RechargeRecord {
  id: string
  timestamp: string
  type: 'single' | 'batch' | 'all'
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

// 待结算的视频任务（用于“超时但最终成功”场景补扣积分）
export interface PendingVideoTask {
  taskId: string
  userId: string
  userName: string
  commandName: string
  credits: number
  createdAt: string
  charged: boolean
  chargedAt?: string
}

export interface PendingVideoTasksData {
  version: string
  lastUpdate: string
  tasks: Record<string, PendingVideoTask>
}

export class UserManager {
  private dataDir: string
  private dataFile: string
  private backupFile: string
  private rechargeHistoryFile: string
  private pendingVideoTasksFile: string
  private logger: any
  private dataLock = new AsyncLock()
  private historyLock = new AsyncLock()
  private pendingLock = new AsyncLock()

  // 内存缓存
  private usersCache: UsersData | null = null
  private pendingVideoCache: PendingVideoTasksData | null = null
  private activeTasks = new Map<string, string>()  // userId -> requestId (图像任务锁)
  private activeVideoTasks = new Map<string, string>()  // userId -> requestId (视频任务锁，独立于图像任务)
  private rateLimitMap = new Map<string, number[]>()  // userId -> timestamps
  private securityBlockMap = new Map<string, number[]>()  // userId -> 拦截时间戳数组
  private securityWarningMap = new Map<string, boolean>()  // userId -> 是否已收到警示

  constructor(baseDir: string, logger: any) {
    this.logger = logger
    this.dataDir = join(baseDir, 'data/aka-ai-generator')
    this.dataFile = join(this.dataDir, 'users_data.json')
    this.backupFile = join(this.dataDir, 'users_data.json.backup')
    this.rechargeHistoryFile = join(this.dataDir, 'recharge_history.json')
    this.pendingVideoTasksFile = join(this.dataDir, 'pending_video_tasks.json')

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
  }

  // --- 任务管理 ---

  // 图像任务锁（原有逻辑保持不变）
  startTask(userId: string): boolean {
    if (this.activeTasks.has(userId)) return false
    this.activeTasks.set(userId, 'processing')
    return true
  }

  endTask(userId: string) {
    this.activeTasks.delete(userId)
  }

  isTaskActive(userId: string): boolean {
    return this.activeTasks.has(userId)
  }

  // 视频任务锁（独立于图像任务，不影响图像生成）
  startVideoTask(userId: string): boolean {
    if (this.activeVideoTasks.has(userId)) return false
    this.activeVideoTasks.set(userId, 'processing')
    return true
  }

  endVideoTask(userId: string) {
    this.activeVideoTasks.delete(userId)
  }

  isVideoTaskActive(userId: string): boolean {
    return this.activeVideoTasks.has(userId)
  }

  // --- 权限管理 ---

  isAdmin(userId: string, config: Config): boolean {
    return config.adminUsers && config.adminUsers.includes(userId)
  }

  // --- 数据持久化 ---

  private async loadUsersData(): Promise<UsersData> {
    // 优先使用缓存
    if (this.usersCache) return this.usersCache

    return await this.dataLock.acquire(async () => {
      // 双重检查
      if (this.usersCache) return this.usersCache

      try {
        if (existsSync(this.dataFile)) {
          const data = await fs.readFile(this.dataFile, 'utf-8')
          this.usersCache = JSON.parse(data)
          return this.usersCache!
        }
      } catch (error) {
        this.logger.error('读取用户数据失败', error)
        // 尝试从备份恢复
        if (existsSync(this.backupFile)) {
          try {
            const backupData = await fs.readFile(this.backupFile, 'utf-8')
            this.logger.warn('从备份文件恢复用户数据')
            this.usersCache = JSON.parse(backupData)
            return this.usersCache!
          } catch (backupError) {
            this.logger.error('备份文件也损坏，使用空数据', backupError)
          }
        }
      }
      this.usersCache = {}
      return this.usersCache!
    })
  }

  // 保存所有用户数据（内部使用）
  private async saveUsersDataInternal(): Promise<void> {
    if (!this.usersCache) return

    try {
      if (existsSync(this.dataFile)) {
        await fs.copyFile(this.dataFile, this.backupFile)
      }
      await fs.writeFile(this.dataFile, JSON.stringify(this.usersCache, null, 2), 'utf-8')
    } catch (error) {
      this.logger.error('保存用户数据失败', error)
      throw error
    }
  }

  // --- 待结算视频任务（防止超时套利） ---

  private async loadPendingVideoTasks(): Promise<PendingVideoTasksData> {
    if (this.pendingVideoCache) return this.pendingVideoCache

    return await this.pendingLock.acquire(async () => {
      if (this.pendingVideoCache) return this.pendingVideoCache

      try {
        if (existsSync(this.pendingVideoTasksFile)) {
          const data = await fs.readFile(this.pendingVideoTasksFile, 'utf-8')
          const parsed = JSON.parse(data)
          this.pendingVideoCache = {
            version: parsed?.version || '1.0.0',
            lastUpdate: parsed?.lastUpdate || new Date().toISOString(),
            tasks: parsed?.tasks || {}
          }
          return this.pendingVideoCache
        }
      } catch (error) {
        this.logger.error('读取待结算视频任务失败', error)
      }

      this.pendingVideoCache = {
        version: '1.0.0',
        lastUpdate: new Date().toISOString(),
        tasks: {}
      }
      return this.pendingVideoCache
    })
  }

  private async savePendingVideoTasksInternal(): Promise<void> {
    if (!this.pendingVideoCache) return
    try {
      this.pendingVideoCache.lastUpdate = new Date().toISOString()
      await fs.writeFile(this.pendingVideoTasksFile, JSON.stringify(this.pendingVideoCache, null, 2), 'utf-8')
    } catch (error) {
      this.logger.error('保存待结算视频任务失败', error)
      throw error
    }
  }

  /**
   * 记录一个待结算的视频任务（任务创建成功后立即写入，避免“超时但最终成功”不扣费）
   */
  async addPendingVideoTask(task: PendingVideoTask): Promise<void> {
    await this.loadPendingVideoTasks()
    await this.pendingLock.acquire(async () => {
      if (!this.pendingVideoCache) {
        this.pendingVideoCache = { version: '1.0.0', lastUpdate: new Date().toISOString(), tasks: {} }
      }
      // 幂等：若已存在则不覆盖（避免重复写入）
      if (this.pendingVideoCache.tasks[task.taskId]) return
      this.pendingVideoCache.tasks[task.taskId] = task
      await this.savePendingVideoTasksInternal()
    })
  }

  async getPendingVideoTask(taskId: string): Promise<PendingVideoTask | null> {
    const data = await this.loadPendingVideoTasks()
    return data.tasks[taskId] || null
  }

  async markPendingVideoTaskCharged(taskId: string): Promise<PendingVideoTask | null> {
    await this.loadPendingVideoTasks()
    return await this.pendingLock.acquire(async () => {
      if (!this.pendingVideoCache) return null
      const task = this.pendingVideoCache.tasks[taskId]
      if (!task) return null
      if (task.charged) return task

      task.charged = true
      task.chargedAt = new Date().toISOString()
      await this.savePendingVideoTasksInternal()
      return task
    })
  }

  async deletePendingVideoTask(taskId: string): Promise<void> {
    await this.loadPendingVideoTasks()
    await this.pendingLock.acquire(async () => {
      if (!this.pendingVideoCache) return
      if (!this.pendingVideoCache.tasks[taskId]) return
      delete this.pendingVideoCache.tasks[taskId]
      await this.savePendingVideoTasksInternal()
    })
  }

  /**
   * 获取某个用户最近一次未扣费的待结算视频任务
   */
  async getLatestPendingVideoTaskForUser(userId: string): Promise<PendingVideoTask | null> {
    const data = await this.loadPendingVideoTasks()
    const tasks = Object.values(data.tasks)
      .filter(t => t.userId === userId && !t.charged)
      .sort((a, b) => {
        const ta = Date.parse(a.createdAt || '') || 0
        const tb = Date.parse(b.createdAt || '') || 0
        return tb - ta
      })
    return tasks[0] || null
  }

  /**
   * 统计某个用户未扣费的待结算视频任务数量
   */
  async countPendingVideoTasksForUser(userId: string): Promise<number> {
    const data = await this.loadPendingVideoTasks()
    return Object.values(data.tasks)
      .filter(t => t.userId === userId && !t.charged)
      .length
  }

  /**
   * 列出某个用户所有未扣费的待结算视频任务
   */
  async listPendingVideoTasksForUser(userId: string): Promise<PendingVideoTask[]> {
    const data = await this.loadPendingVideoTasks()
    return Object.values(data.tasks)
      .filter(t => t.userId === userId && !t.charged)
      .sort((a, b) => {
        const ta = Date.parse(a.createdAt || '') || 0
        const tb = Date.parse(b.createdAt || '') || 0
        return tb - ta // 最新的在前
      })
  }

  /**
   * 添加待结算视频任务，并检查上限（默认max=1）
   * @returns {Promise<{success: boolean, message?: string}>} 成功返回 {success: true}，失败返回 {success: false, message: '错误信息'}
   */
  async addPendingVideoTaskWithLimit(task: PendingVideoTask, max: number = 1): Promise<{ success: boolean, message?: string }> {
    await this.loadPendingVideoTasks()
    return await this.pendingLock.acquire(async () => {
      if (!this.pendingVideoCache) {
        this.pendingVideoCache = { version: '1.0.0', lastUpdate: new Date().toISOString(), tasks: {} }
      }

      // 检查该用户未扣费任务数量
      const currentCount = Object.values(this.pendingVideoCache.tasks)
        .filter(t => t.userId === task.userId && !t.charged)
        .length

      if (currentCount >= max) {
        return {
          success: false,
          message: `您当前已有 ${currentCount} 个视频正在生成中（最多允许 ${max} 个），请先使用"查询视频"查看进度或等待完成`
        }
      }

      // 幂等：若已存在则不覆盖（避免重复写入）
      if (this.pendingVideoCache.tasks[task.taskId]) {
        return { success: true } // 已存在，视为成功
      }

      this.pendingVideoCache.tasks[task.taskId] = task
      await this.savePendingVideoTasksInternal()
      return { success: true }
    })
  }

  // 获取特定用户数据
  async getUserData(userId: string, userName: string): Promise<UserData> {
    await this.loadUsersData()
    // 此时 this.usersCache 一定不为 null

    if (!this.usersCache![userId]) {
      // 在锁内创建新用户，防止并发创建覆盖
      await this.dataLock.acquire(async () => {
        if (this.usersCache![userId]) return // 双重检查

        this.usersCache![userId] = {
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
        await this.saveUsersDataInternal()
        this.logger.info('创建新用户数据', { userId, userName })
      })
    }

    return this.usersCache![userId]
  }

  // 获取所有用户数据 (用于充值等批量操作)
  async getAllUsers(): Promise<UsersData> {
    return await this.loadUsersData()
  }

  // 批量更新用户数据 (用于充值)
  async updateUsersBatch(updates: (data: UsersData) => void): Promise<void> {
    // 在锁外先确保数据已加载（避免死锁）
    await this.loadUsersData()

    await this.dataLock.acquire(async () => {
      // 在锁内直接使用缓存，不再调用 loadUsersData（避免死锁）
      if (!this.usersCache) {
        this.logger.error('updateUsersBatch: usersCache 为空，这不应该发生')
        this.usersCache = {}
      }
      updates(this.usersCache!)
      await this.saveUsersDataInternal()
    })
  }

  // --- 充值历史 ---

  async loadRechargeHistory(): Promise<RechargeHistory> {
    return await this.historyLock.acquire(async () => {
      try {
        if (existsSync(this.rechargeHistoryFile)) {
          const data = await fs.readFile(this.rechargeHistoryFile, 'utf-8')
          return JSON.parse(data)
        }
      } catch (error) {
        this.logger.error('读取充值历史失败', error)
      }
      return {
        version: '1.0.0',
        lastUpdate: new Date().toISOString(),
        records: []
      }
    })
  }

  async addRechargeRecord(record: RechargeRecord): Promise<void> {
    await this.historyLock.acquire(async () => {
      let history: RechargeHistory
      try {
        if (existsSync(this.rechargeHistoryFile)) {
          history = JSON.parse(await fs.readFile(this.rechargeHistoryFile, 'utf-8'))
        } else {
          history = { version: '1.0.0', lastUpdate: '', records: [] }
        }
      } catch (e) {
        history = { version: '1.0.0', lastUpdate: '', records: [] }
      }

      history.records.push(record)
      history.lastUpdate = new Date().toISOString()
      await fs.writeFile(this.rechargeHistoryFile, JSON.stringify(history, null, 2), 'utf-8')
    })
  }

  // --- 限流逻辑 ---

  checkRateLimit(userId: string, config: Config): { allowed: boolean, message?: string } {
    const now = Date.now()
    const userTimestamps = this.rateLimitMap.get(userId) || []
    const windowStart = now - config.rateLimitWindow * 1000

    // 清理过期的时间戳
    const validTimestamps = userTimestamps.filter(timestamp => timestamp > windowStart)

    // 更新缓存
    this.rateLimitMap.set(userId, validTimestamps)

    if (validTimestamps.length >= config.rateLimitMax) {
      return {
        allowed: false,
        message: `操作过于频繁，请${Math.ceil((validTimestamps[0] + config.rateLimitWindow * 1000 - now) / 1000)}秒后再试`
      }
    }

    return { allowed: true }
  }

  updateRateLimit(userId: string): void {
    const now = Date.now()
    const userTimestamps = this.rateLimitMap.get(userId) || []
    userTimestamps.push(now)
    this.rateLimitMap.set(userId, userTimestamps)
  }

  // --- 核心业务逻辑 ---

  async checkDailyLimit(userId: string, config: Config, numImages: number = 1): Promise<{ allowed: boolean, message?: string, isAdmin?: boolean }> {
    if (this.isAdmin(userId, config)) {
      return { allowed: true, isAdmin: true }
    }

    const rateLimitCheck = this.checkRateLimit(userId, config)
    if (!rateLimitCheck.allowed) {
      return { ...rateLimitCheck, isAdmin: false }
    }

    this.updateRateLimit(userId)

    const userData = await this.getUserData(userId, userId) // 获取或初始化

    // 注意：getUserData 返回的是缓存对象的引用，直接读取是安全的，但修改需要加锁
    // 但这里我们只是读取来做判断，真正的扣减在 updateUserData

    const today = new Date().toDateString()
    const lastReset = new Date(userData.lastDailyReset || userData.createdAt).toDateString()

    // 内存中的临时计算，不直接修改持久化数据
    let dailyCount = userData.dailyUsageCount
    if (today !== lastReset) {
      dailyCount = 0
    }

    if (numImages > config.dailyFreeLimit && userData.totalUsageCount === 0 && userData.purchasedCount === 0) {
      // 特殊情况：新用户且一次性请求超过免费额度
      // 但其实 getUserData 会初始化 totalUsageCount=0
      // 这里的逻辑主要是为了给用户友好的提示
    }

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

  // 原子性地检查并预留额度（防止并发绕过）
  async checkAndReserveQuota(
    userId: string,
    userName: string,
    numImages: number,
    config: Config,
    platform?: string  // 新增：平台参数，用于检查平台免配额
  ): Promise<{ allowed: boolean; message?: string; reservationId?: string }> {
    // 管理员免配额
    if (this.isAdmin(userId, config)) {
      return { allowed: true, reservationId: 'admin' }
    }

    // 平台免配额（如飞书/lark）
    if (platform && config.unlimitedPlatforms?.includes(platform)) {
      return { allowed: true, reservationId: 'platform_exempt' }
    }

    const rateLimitCheck = this.checkRateLimit(userId, config)
    if (!rateLimitCheck.allowed) {
      return { ...rateLimitCheck }
    }

    this.updateRateLimit(userId)

    // 在锁外先获取用户数据（避免死锁）
    await this.loadUsersData()
    const userData = await this.getUserData(userId, userName)

    return await this.dataLock.acquire(async () => {
      // 在锁内直接使用缓存中的数据（避免死锁）
      // 确保缓存存在
      if (!this.usersCache) {
        this.logger.error('checkAndReserveQuota: usersCache 为空，这不应该发生')
        this.usersCache = {}
      }

      // 重新获取用户数据（从缓存中，确保是最新的）
      const cachedUserData = this.usersCache[userId] || userData

      const today = new Date().toDateString()
      const lastReset = new Date(cachedUserData.lastDailyReset || cachedUserData.createdAt).toDateString()

      let dailyCount = cachedUserData.dailyUsageCount
      if (today !== lastReset) {
        dailyCount = 0
      }

      const remainingToday = Math.max(0, config.dailyFreeLimit - dailyCount)
      const totalAvailable = remainingToday + cachedUserData.remainingPurchasedCount

      if (totalAvailable < numImages) {
        return {
          allowed: false,
          message: `生成 ${numImages} 张图片需要 ${numImages} 次可用次数，但您的可用次数不足（今日免费剩余：${remainingToday}次，充值剩余：${cachedUserData.remainingPurchasedCount}次，共${totalAvailable}次）`
        }
      }

      // 预留额度（暂不持久化，在内存标记）
      const reservationId = `${userId}_${Date.now()}_${Math.random()}`
      return { allowed: true, reservationId }
    })
  }

  // 只记录调用次数，不扣减配额（用于管理员和平台免配额用户）
  async recordUsageOnly(userId: string, userName: string, commandName: string, numImages: number): Promise<UserData> {
    // 在锁外先确保数据已加载（避免死锁）
    await this.loadUsersData()

    return await this.dataLock.acquire(async () => {
      if (!this.usersCache) {
        this.logger.error('recordUsageOnly: usersCache 为空，这不应该发生')
        this.usersCache = {}
      }

      let userData = this.usersCache![userId]
      const now = new Date().toISOString()

      if (!userData) {
        userData = {
          userId,
          userName: userName || userId,
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
        this.usersCache![userId] = userData
      }

      // 只增加总调用次数，不扣减免费/充值额度
      userData.totalUsageCount += numImages
      userData.lastUsed = now

      await this.saveUsersDataInternal()
      this.logger.debug('recordUsageOnly: 仅记录调用次数', { userId, userName, commandName, numImages, totalUsageCount: userData.totalUsageCount })

      return userData
    })
  }

  // 扣减额度并记录使用
  async consumeQuota(userId: string, userName: string, commandName: string, numImages: number, config: Config): Promise<{ userData: UserData, consumptionType: 'free' | 'purchased' | 'mixed', freeUsed: number, purchasedUsed: number }> {
    // 在锁外先确保数据已加载（避免死锁）
    await this.loadUsersData()

    return await this.dataLock.acquire(async () => {
      // 在锁内直接使用缓存，不再调用 loadUsersData（避免死锁）
      // 确保缓存存在（理论上已经加载，但为了安全起见）
      if (!this.usersCache) {
        this.logger.error('consumeQuota: usersCache 为空，这不应该发生')
        this.usersCache = {}
      }

      let userData = this.usersCache![userId]
      const now = new Date().toISOString()
      const today = new Date().toDateString()

      if (!userData) {
        // 理论上不会发生，因为前面 checkDailyLimit 应该已经创建了
        // 但为了安全起见
        userData = {
          userId,
          userName: userName || userId,
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
        this.usersCache![userId] = userData
      }

      userData.totalUsageCount += numImages
      userData.lastUsed = now

      // 重置每日计数
      const lastReset = new Date(userData.lastDailyReset || userData.createdAt).toDateString()
      if (today !== lastReset) {
        userData.dailyUsageCount = 0
        userData.lastDailyReset = now
      }

      let remainingToConsume = numImages
      let freeUsed = 0
      let purchasedUsed = 0

      // 优先消耗免费次数
      const availableFree = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
      if (availableFree > 0) {
        const freeToUse = Math.min(availableFree, remainingToConsume)
        userData.dailyUsageCount += freeToUse
        freeUsed = freeToUse
        remainingToConsume -= freeToUse
      }

      // 消耗充值次数
      if (remainingToConsume > 0) {
        const purchasedToUse = Math.min(userData.remainingPurchasedCount, remainingToConsume)
        userData.remainingPurchasedCount -= purchasedToUse
        purchasedUsed = purchasedToUse
        remainingToConsume -= purchasedToUse
      }

      await this.saveUsersDataInternal()

      let consumptionType: 'free' | 'purchased' | 'mixed'
      if (freeUsed > 0 && purchasedUsed > 0) {
        consumptionType = 'mixed'
      } else if (freeUsed > 0) {
        consumptionType = 'free'
      } else {
        consumptionType = 'purchased'
      }

      return { userData, consumptionType, freeUsed, purchasedUsed }
    })
  }

  // 记录安全拦截
  async recordSecurityBlock(userId: string, config: Config): Promise<{ shouldWarn: boolean, shouldDeduct: boolean, blockCount: number }> {
    if (!userId) return { shouldWarn: false, shouldDeduct: false, blockCount: 0 }

    // 管理员豁免
    if (this.isAdmin(userId, config)) return { shouldWarn: false, shouldDeduct: false, blockCount: 0 }

    const now = Date.now()
    const windowMs = config.securityBlockWindow * 1000
    const windowStart = now - windowMs

    let blockTimestamps = this.securityBlockMap.get(userId) || []
    blockTimestamps = blockTimestamps.filter(timestamp => timestamp > windowStart)
    blockTimestamps.push(now)
    this.securityBlockMap.set(userId, blockTimestamps)

    const blockCount = blockTimestamps.length
    const hasWarning = this.securityWarningMap.get(userId) || false

    let shouldWarn = false
    let shouldDeduct = false

    if (blockCount >= config.securityBlockWarningThreshold && !hasWarning) {
      this.securityWarningMap.set(userId, true)
      shouldWarn = true
    } else if (blockCount > config.securityBlockWarningThreshold) {
      // 修改：超过阈值后，每次都扣除积分（而不是只有 hasWarning 才扣）
      shouldDeduct = true
    }

    return { shouldWarn, shouldDeduct, blockCount }
  }
}

