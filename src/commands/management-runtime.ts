import { h } from 'koishi'
import type { Context, Session } from 'koishi'
import type { Config } from '../shared/config'
import type { RechargeRecord, UserManager } from '../services/UserManager'

interface ManagementRuntimeDeps {
  config: Config
  logger: ReturnType<Context['logger']>
  userManager: UserManager
  getPromptInput: (session: Session, message: string) => Promise<string | null>
}

export async function handleRechargeCommand(
  deps: ManagementRuntimeDeps,
  session: Session,
  content?: string,
) {
  const { config, logger, userManager, getPromptInput } = deps

  if (!session?.userId) return '会话无效'
  if (!userManager.isAdmin(session.userId, config)) {
    return '权限不足，仅管理员可操作'
  }

  const inputContent = content || await getPromptInput(session, '请输入充值信息，格式：\n@用户1 @用户2 充值次数 [备注]')
  if (!inputContent) return '输入超时或无效'

  const elements = h.parse(inputContent)
  const atElements = h.select(elements, 'at')
  const textElements = h.select(elements, 'text')
  const text = textElements.map(el => el.attrs.content).join(' ').trim()

  if (atElements.length === 0) {
    return '未找到@用户，请使用@用户的方式'
  }

  const parts = text.split(/\s+/).filter(p => p)
  if (parts.length === 0) {
    return '请输入充值次数'
  }

  const amount = parseInt(parts[0], 10)
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
    const recordId = `recharge_${now.replace(/[-:T.]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 5)}`
    const targets: RechargeRecord['targets'] = []
    let totalAmount = 0

    await userManager.updateUsersBatch((usersData) => {
      for (const userId of userIds) {
        if (!userId) continue

        let userName = userId
        if (usersData[userId]) {
          userName = usersData[userId].userName || userId
        } else {
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
            createdAt: now,
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
          afterBalance: usersData[userId].remainingPurchasedCount,
        })
      }
      totalAmount = amount * targets.length
    })

    await userManager.addRechargeRecord({
      id: recordId,
      timestamp: now,
      type: targets.length > 1 ? 'batch' : 'single',
      operator: {
        userId: session.userId,
        userName: session.username || session.userId,
      },
      targets,
      totalAmount,
      note,
      metadata: {},
    })

    const userList = targets.map(t => `${t.userName}(${t.afterBalance}次)`).join(', ')
    return `✅ 充值成功\n目标用户：${userList}\n充值次数：${amount}次/人\n总充值：${totalAmount}次\n操作员：${session.username}\n备注：${note}`
  } catch (error) {
    logger.error('充值操作失败', error)
    return '充值失败，请稍后重试'
  }
}

export async function handleRechargeAllCommand(
  deps: ManagementRuntimeDeps,
  session: Session,
  content?: string,
) {
  const { config, logger, userManager, getPromptInput } = deps

  if (!session?.userId) return '会话无效'
  if (!userManager.isAdmin(session.userId, config)) {
    return '权限不足，仅管理员可操作'
  }

  const inputContent = content || await getPromptInput(session, '请输入活动充值信息，格式：\n充值次数 [备注]\n例如：20 或 20 春节活动奖励')
  if (!inputContent) return '输入超时或无效'

  const elements = h.parse(inputContent)
  const textElements = h.select(elements, 'text')
  const text = textElements.map(el => el.attrs.content).join(' ').trim()
  const parts = text.split(/\s+/).filter(p => p)
  if (parts.length === 0) {
    return '请输入充值次数，例如：图像活动充值 20 或 图像活动充值 20 活动名称'
  }

  const amount = parseInt(parts[0], 10)
  const note = parts.slice(1).join(' ') || '活动充值'
  if (!amount || amount <= 0) {
    return '充值次数必须大于0'
  }

  try {
    const now = new Date().toISOString()
    const recordId = `recharge_all_${now.replace(/[-:T.]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 5)}`
    const targets: RechargeRecord['targets'] = []
    let totalAmount = 0
    let successCount = 0

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
          afterBalance: userData.remainingPurchasedCount,
        })
        successCount++
      }
      totalAmount = amount * successCount
    })

    if (successCount === 0) {
      return '当前没有使用过插件的用户，无法进行活动充值'
    }

    await userManager.addRechargeRecord({
      id: recordId,
      timestamp: now,
      type: 'all',
      operator: {
        userId: session.userId,
        userName: session.username || session.userId,
      },
      targets,
      totalAmount,
      note,
      metadata: { all: true },
    })

    return `✅ 活动充值成功\n目标用户数：${successCount}人\n充值次数：${amount}次/人\n总充值：${totalAmount}次\n操作员：${session.username}\n备注：${note}`
  } catch (error) {
    logger.error('活动充值操作失败', error)
    return '活动充值失败，请稍后重试'
  }
}

export async function handleQueryQuotaCommand(
  deps: ManagementRuntimeDeps,
  session: Session,
  target?: string,
) {
  const { config, logger, userManager } = deps

  if (!session?.userId) return '会话无效'

  const userIsAdmin = userManager.isAdmin(session.userId, config)
  let targetUserId = session.userId
  let targetUserName = session.username || session.userId

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
    const remainingToday = Math.max(0, config.dailyFreeLimit - userData.dailyUsageCount)
    const totalAvailable = remainingToday + userData.remainingPurchasedCount

    return `👤 用户额度信息\n用户：${userData.userName}\n今日剩余免费：${remainingToday}次\n充值剩余：${userData.remainingPurchasedCount}次\n总可用次数：${totalAvailable}次\n历史总调用：${userData.totalUsageCount}次\n历史总充值：${userData.purchasedCount}次`
  } catch (error) {
    logger.error('查询额度失败', error)
    return '查询失败，请稍后重试'
  }
}

export async function handleRechargeHistoryCommand(
  deps: ManagementRuntimeDeps,
  session: Session,
  page: number = 1,
) {
  const { config, logger, userManager } = deps

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
    const records = history.records.slice(startIndex, endIndex).reverse()

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
}
