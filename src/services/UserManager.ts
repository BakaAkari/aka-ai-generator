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

export class UserManager {
  private dataDir: string
  private dataFile: string
  private backupFile: string
  private rechargeHistoryFile: string
  private logger: any
  private dataLock = new AsyncLock()
  private historyLock = new AsyncLock()
  
  // 内存缓存
  private usersCache: UsersData | null = null
  private activeTasks = new Map<string, string>()  // userId -> requestId
  private rateLimitMap = new Map<string, number[]>()  // userId -> timestamps
  private securityBlockMap = new Map<string, number[]>()  // userId -> 拦截时间戳数组
  private securityWarningMap = new Map<string, boolean>()  // userId -> 是否已收到警示

  constructor(baseDir: string, logger: any) {
    this.logger = logger
    this.dataDir = join(baseDir, 'data/aka-ai-generator')
    this.dataFile = join(this.dataDir, 'users_data.json')
    this.backupFile = join(this.dataDir, 'users_data.json.backup')
    this.rechargeHistoryFile = join(this.dataDir, 'recharge_history.json')

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true })
    }
  }

  // --- 任务管理 ---

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
      await this.dataLock.acquire(async () => {
          await this.loadUsersData() // 确保是最新的
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

  // 扣减额度并记录使用
  async consumeQuota(userId: string, userName: string, commandName: string, numImages: number, config: Config): Promise<{ userData: UserData, consumptionType: 'free' | 'purchased' | 'mixed', freeUsed: number, purchasedUsed: number }> {
    return await this.dataLock.acquire(async () => {
        await this.loadUsersData() // 确保最新
        
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
    } else if (hasWarning) {
        shouldDeduct = true
    }

    return { shouldWarn, shouldDeduct, blockCount }
  }
}

