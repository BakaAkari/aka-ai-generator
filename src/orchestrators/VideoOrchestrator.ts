import { h, Session } from 'koishi'
import { YunwuVideoProvider } from '../providers/yunwu-video'
import { UserManager } from '../services/UserManager'

interface RunVideoGenerationFlowParams {
  session: Session
  userId: string
  userManager: UserManager
  videoProvider: YunwuVideoProvider
  logger: any
  sanitizeString: (message: string) => string
  sanitizeError: (error: any) => any
  recordUserUsage: (session: Session, commandName: string, numImages?: number, sendStatsImmediately?: boolean) => Promise<void>
  commandName: string
  prompt: string
  imageUrl: string
  videoCredits: number
  maxWaitTime: number
  startMessage: string
  videoOptions: {
    duration: number
    aspectRatio: string
  }
}

export async function runVideoGenerationFlow(params: RunVideoGenerationFlowParams): Promise<string> {
  const {
    session,
    userId,
    userManager,
    videoProvider,
    logger,
    sanitizeString,
    sanitizeError,
    recordUserUsage,
    commandName,
    prompt,
    imageUrl,
    videoCredits,
    maxWaitTime,
    startMessage,
    videoOptions
  } = params

  let createdTaskId: string | null = null

  try {
    const taskId = await videoProvider.createVideoTask(prompt, imageUrl, videoOptions)
    createdTaskId = taskId

    const addResult = await userManager.addPendingVideoTaskWithLimit({
      taskId,
      userId,
      userName: session.username || userId || '未知用户',
      commandName,
      credits: videoCredits,
      createdAt: new Date().toISOString(),
      charged: false
    }, 1)

    if (!addResult.success) {
      try { await userManager.deletePendingVideoTask(taskId) } catch { }
      return addResult.message || '队列已满，请先查询已有任务'
    }

    await session.send(startMessage)

    await new Promise(resolve => setTimeout(resolve, 10000))

    try {
      const firstStatus = await videoProvider.queryTaskStatus(taskId)

      if (firstStatus.status === 'failed') {
        const errorMsg = firstStatus.error || '视频生成失败'
        await userManager.deletePendingVideoTask(taskId)
        return `视频生成失败：${sanitizeString(errorMsg)}`
      }

      if (firstStatus.status === 'completed' && firstStatus.videoUrl) {
        await session.send(h.video(firstStatus.videoUrl))
        await recordUserUsage(session, commandName, videoCredits, false)
        await userManager.markPendingVideoTaskCharged(taskId)
        await userManager.deletePendingVideoTask(taskId)
        return '视频生成完成！'
      }

      await session.send('视频正在生成中，请稍候...')
    } catch (error: any) {
      logger.error('第一次查询视频状态失败', { taskId, error: sanitizeError(error) })
    }

    await new Promise(resolve => setTimeout(resolve, maxWaitTime * 1000))

    try {
      const secondStatus = await videoProvider.queryTaskStatus(taskId)

      if (secondStatus.status === 'completed' && secondStatus.videoUrl) {
        await session.send(h.video(secondStatus.videoUrl))
        await recordUserUsage(session, commandName, videoCredits, false)
        await userManager.markPendingVideoTaskCharged(taskId)
        await userManager.deletePendingVideoTask(taskId)
        return '视频生成完成！'
      }

      if (secondStatus.status === 'failed') {
        const errorMsg = secondStatus.error || '视频生成失败'
        await userManager.deletePendingVideoTask(taskId)
        return `视频生成失败：${sanitizeString(errorMsg)}`
      }

      return '视频仍在生成中，请稍后使用"查询视频"指令获取结果'
    } catch (error: any) {
      logger.error('第二次查询视频状态失败', { taskId, error: sanitizeError(error) })
      return '视频生成中，请稍后使用"查询视频"指令获取结果'
    }
  } catch (error: any) {
    logger.error('视频生成任务提交失败', { userId, error: sanitizeError(error), commandName })

    if (createdTaskId) {
      try { await userManager.deletePendingVideoTask(createdTaskId) } catch { }
    }

    const errorMsg = error?.message || ''
    return `视频生成任务提交失败：${sanitizeString(errorMsg)}`
  } finally {
    userManager.endVideoTask(userId)
  }
}

