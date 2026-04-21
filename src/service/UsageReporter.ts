import type { Context, Session } from 'koishi'
import type { AiGeneratorService } from './AiGeneratorService'
import type { Config } from '../shared/config'
import type { UserManager } from '../services/UserManager'

export class UsageReporter {
  private config: Config
  private readonly userManager: UserManager
  private readonly aiGenerator: AiGeneratorService
  private readonly logger: ReturnType<Context['logger']>
  private readonly sanitizeError: (error: unknown) => unknown

  constructor(params: {
    config: Config
    userManager: UserManager
    aiGenerator: AiGeneratorService
    logger: ReturnType<Context['logger']>
    sanitizeError: (error: unknown) => unknown
  }) {
    this.config = params.config
    this.userManager = params.userManager
    this.aiGenerator = params.aiGenerator
    this.logger = params.logger
    this.sanitizeError = params.sanitizeError
  }

  updateConfig(config: Config) {
    this.config = config
  }

  getSessionUserName(session?: Pick<Session, 'userId' | 'username'> | null) {
    return session?.username || session?.userId || '未知用户'
  }

  async reserveGenerationQuota(session: Session, numImages: number) {
    const userId = session.userId
    if (!userId) {
      return { allowed: false, message: '会话无效' }
    }

    return this.aiGenerator.checkAndReserveQuota(
      userId,
      this.getSessionUserName(session),
      numImages,
      session.platform,
    )
  }

  async recordUsage(
    session: Session,
    commandName: string,
    numImages: number = 1,
    sendStatsImmediately: boolean = true,
  ) {
    const userId = session.userId
    const userName = this.getSessionUserName(session)
    const platform = session.platform
    if (!userId) return

    const isPlatformExempt = platform && this.config.unlimitedPlatforms?.includes(platform)
    const isAdmin = this.userManager.isAdmin(userId, this.config)
    const isPermanentMember = this.userManager.isPermanentMember(userId, this.config)

    let userData: any
    let consumptionType: 'free' | 'purchased' | 'mixed' = 'free'
    let freeUsed = 0
    let purchasedUsed = 0

    if (isAdmin || isPermanentMember || isPlatformExempt) {
      userData = await this.userManager.recordUsageOnly(userId, userName, commandName, numImages)
    } else {
      const result = await this.userManager.consumeQuota(userId, userName, commandName, numImages, this.config)
      userData = result.userData
      consumptionType = result.consumptionType
      freeUsed = result.freeUsed
      purchasedUsed = result.purchasedUsed
    }

    this.logger.info('用户调用记录', {
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
      isPermanentMember,
      isPlatformExempt,
      platform,
    })

    if (sendStatsImmediately) {
      try {
        const statsMessage = this.buildStatsMessage(
          userData,
          numImages,
          consumptionType,
          freeUsed,
          purchasedUsed,
          platform,
        )
        await session.send(statsMessage)
      } catch (error) {
        this.logger.warn('发送统计信息失败', { userId, error: this.sanitizeError(error) })
      }
      return
    }

    setImmediate(async () => {
      try {
        const statsMessage = this.buildStatsMessage(
          userData,
          numImages,
          consumptionType,
          freeUsed,
          purchasedUsed,
          platform,
        )
        await session.send(statsMessage)
        this.logger.debug('统计信息已异步发送', { userId, commandName })
      } catch (error) {
        this.logger.warn('异步发送统计信息失败', { userId, error: this.sanitizeError(error) })
      }
    })
  }

  async recordSecurityBlock(session: Session, numImages: number = 1): Promise<void> {
    const userId = session.userId
    if (!userId) return

    const { shouldWarn, shouldDeduct, blockCount } = await this.userManager.recordSecurityBlock(userId, this.config)

    this.logger.info('安全策略拦截记录', {
      userId,
      blockCount,
      threshold: this.config.securityBlockWarningThreshold,
      shouldWarn,
      shouldDeduct,
      numImages,
    })

    if (shouldWarn) {
      await session.send(
        `⚠️ 安全策略警示\n您已连续${this.config.securityBlockWarningThreshold}次触发安全策略拦截，再次发送被拦截内容将被扣除积分`,
      )
      this.logger.warn('用户收到安全策略警示', {
        userId,
        blockCount,
        threshold: this.config.securityBlockWarningThreshold,
      })
      return
    }

    if (shouldDeduct) {
      await this.recordUsage(session, '安全策略拦截', numImages)
      this.logger.warn('用户因安全策略拦截被扣除积分', { userId, numImages })
    }
  }

  private buildStatsMessage(
    userData: any,
    numImages: number,
    consumptionType: string,
    freeUsed: number,
    purchasedUsed: number,
    platform?: string,
  ): string {
    const isAdmin = this.userManager.isAdmin(userData.userId, this.config)
    const isPermanentMember = this.userManager.isPermanentMember(userData.userId, this.config)
    const isPlatformExempt = platform && this.config.unlimitedPlatforms?.includes(platform)

    if (isAdmin) {
      return `📊 使用统计 [管理员]\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`
    }

    if (isPermanentMember) {
      return `📊 使用统计 [永久会员]\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`
    }

    if (isPlatformExempt) {
      return `📊 使用统计\n用户：${userData.userName}\n总调用次数：${userData.totalUsageCount}次\n状态：无限制使用`
    }

    const remainingToday = Math.max(0, this.config.dailyFreeLimit - userData.dailyUsageCount)
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
}
