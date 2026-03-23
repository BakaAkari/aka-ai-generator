import { h } from 'koishi'
import type { Context, Session } from 'koishi'
import type { VideoProvider } from '../providers/video-index'
import { runVideoGenerationFlow } from '../orchestrators/VideoOrchestrator'
import type { Config } from '../shared/config'
import { formatPromptTimeoutError, getPromptTimeoutMs, getPromptTimeoutText } from '../shared/prompt-timeout'
import type { UserManager } from '../services/UserManager'
import { collectImagesFromParamAndQuote, parseMessageImagesAndText } from '../utils/input'

interface VideoRuntimeDeps {
  config: Config
  logger: ReturnType<Context['logger']>
  userManager: UserManager
  videoProvider: VideoProvider | null
  sanitizeString: (message: string) => string
  sanitizeError: (error: unknown) => unknown
  recordUserUsage: (
    session: Session,
    commandName: string,
    numImages?: number,
    sendStatsImmediately?: boolean,
  ) => Promise<void>
  getSessionUserName: (session?: Pick<Session, 'userId' | 'username'> | null) => string
}

export interface ExecuteVideoGenerationOptions {
  commandName: string
  startMessage: string
  basePrompt?: string
  duration: number
  aspectRatio: string
  askPromptIfEmpty: boolean
  mode: 'single' | 'multiple'
}

export async function executeVideoGenerationCommand(
  deps: VideoRuntimeDeps,
  session: Session,
  img: any,
  options: ExecuteVideoGenerationOptions,
): Promise<string> {
  const {
    config,
    logger,
    userManager,
    videoProvider,
    sanitizeString,
    sanitizeError,
    recordUserUsage,
    getSessionUserName,
  } = deps

  if (!session?.userId) return '会话无效'
  if (!videoProvider) return '视频生成功能未启用'

  const userId = session.userId
  const userName = getSessionUserName(session)
  const videoCredits = config.videoCreditsMultiplier

  const limitCheck = await userManager.checkAndReserveQuota(
    userId,
    userName,
    videoCredits,
    config,
    session.platform,
  )
  if (!limitCheck.allowed) {
    return limitCheck.message
  }

  if (!userManager.startVideoTask(userId)) {
    return '您有一个视频任务正在进行中，请等待完成'
  }

  const inputResult = await getVideoInputData(session, config, img, options.mode)
  if ('error' in inputResult) {
    userManager.endVideoTask(userId)
    return inputResult.error
  }

  const { images: imageUrls, text: extraText } = inputResult

  if (options.mode === 'single') {
    if (imageUrls.length === 0) {
      userManager.endVideoTask(userId)
      return '未检测到输入图片，请发送一张图片'
    }
    if (imageUrls.length > 1) {
      userManager.endVideoTask(userId)
      return '单图生视频只支持1张图片，请使用"多图生视频"命令处理多张图片'
    }
  } else {
    if (imageUrls.length === 0) {
      userManager.endVideoTask(userId)
      return '未检测到输入图片，请至少发送一张图片'
    }
    if (imageUrls.length > 4) {
      userManager.endVideoTask(userId)
      return '最多支持4张图片，请减少图片数量'
    }
    if (imageUrls.length >= 2) {
      await session.send(`已收到 ${imageUrls.length} 张图片，将用于多图视频合成`)
    }
  }

  let finalPrompt = (options.basePrompt || '').trim()
  if (extraText) {
    finalPrompt = finalPrompt ? `${finalPrompt} - ${extraText}` : extraText
  }

  if (!finalPrompt && options.askPromptIfEmpty) {
    await session.send('请输入视频描述（描述视频中的动作和场景变化）\n提示：描述越详细，生成效果越好')
    const promptMsg = await session.prompt(getPromptTimeoutMs(config))
    if (!promptMsg) {
      userManager.endVideoTask(userId)
      return formatPromptTimeoutError(config)
    }

    const { images, text } = parseMessageImagesAndText(promptMsg)
    if (images.length > 0) {
      userManager.endVideoTask(userId)
      return '检测到图片，本功能仅支持文字输入'
    }
    if (!text) {
      userManager.endVideoTask(userId)
      return '未检测到描述'
    }
    finalPrompt = text
  }

  if (!finalPrompt) {
    userManager.endVideoTask(userId)
    return '未检测到描述'
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
    commandName: options.commandName,
    prompt: finalPrompt,
    imageUrls,
    videoCredits,
    maxWaitTime: config.videoMaxWaitTime,
    startMessage: options.startMessage,
    videoOptions: {
      duration: options.duration,
      aspectRatio: options.aspectRatio,
    },
  })
}

export async function queryVideoTasks(
  deps: VideoRuntimeDeps,
  session: Session,
  taskId?: string,
) {
  const {
    logger,
    userManager,
    videoProvider,
    sanitizeString,
    sanitizeError,
    recordUserUsage,
  } = deps

  if (!session?.userId) return '会话无效'
  if (!videoProvider) return '视频生成功能未启用'

  const trimmedTaskId = (taskId || '').trim()

  if (trimmedTaskId) {
    try {
      await session.send('正在查询视频生成状态...')

      const status = await videoProvider.queryTaskStatus(trimmedTaskId)
      const pending = await userManager.getPendingVideoTask(trimmedTaskId)

      if (pending && pending.userId && pending.userId !== session.userId) {
        return '该任务ID不属于当前用户，无法查询'
      }

      if (status.status === 'completed' && status.videoUrl) {
        await session.send(h.video(status.videoUrl))

        if (pending && !pending.charged) {
          await recordUserUsage(session, pending.commandName, pending.credits, false)
          await userManager.markPendingVideoTaskCharged(trimmedTaskId)
          await userManager.deletePendingVideoTask(trimmedTaskId)
        }

        userManager.endVideoTask(session.userId)
        return '视频生成完成！'
      }

      if (status.status === 'processing' || status.status === 'pending') {
        const progressText = status.progress ? `（进度：${status.progress}%）` : ''
        return `视频正在生成中${progressText}，请稍后再次查询`
      }

      if (status.status === 'failed') {
        if (pending && !pending.charged) {
          await userManager.deletePendingVideoTask(trimmedTaskId)
        }
        userManager.endVideoTask(session.userId)
        return `视频生成失败：${status.error || '未知错误'}`
      }

      return `❓ 未知状态：${status.status}`
    } catch (error: any) {
      logger.error('查询视频任务失败', { taskId: trimmedTaskId, error: sanitizeError(error) })
      return `查询失败：${sanitizeString(error.message)}`
    }
  }

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

    for (const task of pendingTasks) {
      try {
        const status = await videoProvider.queryTaskStatus(task.taskId)

        if (status.status === 'completed' && status.videoUrl) {
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

    if (completedCount > 0 || failedCount > 0) {
      userManager.endVideoTask(session.userId)
    }

    let summary = '查询结果汇总：\n'
    if (completedCount > 0) summary += `已完成：${completedCount} 个\n`
    if (processingCount > 0) summary += `生成中：${processingCount} 个\n`
    if (failedCount > 0) summary += `失败：${failedCount} 个\n`
    summary += `\n${messages.join('\n')}`

    return summary
  } catch (error: any) {
    logger.error('查询视频任务列表失败', { userId: session.userId, error: sanitizeError(error) })
    return `查询失败：${sanitizeString(error.message)}`
  }
}

async function getVideoInputData(
  session: Session,
  config: Pick<Config, 'apiTimeout'>,
  imgParam: any,
  mode: 'single' | 'multiple',
): Promise<{ images: string[], text?: string } | { error: string }> {
  const collectedImages: string[] = collectImagesFromParamAndQuote(session, imgParam)
  let collectedText = ''

  if (collectedImages.length > 0 && mode === 'single' && collectedImages.length > 1) {
    return { error: '单图生视频只支持1张图片，请使用"多图生视频"命令处理多张图片' }
  }

  if (collectedImages.length === 0) {
    const promptMessage = mode === 'single'
      ? `请在${getPromptTimeoutText(config)}内发送一张图片`
      : `请在${getPromptTimeoutText(config)}内发送图片（可附带文字说明）`
    await session.send(promptMessage)
  }

  while (collectedImages.length === 0 || (mode === 'multiple' && !collectedText)) {
    const msg = await session.prompt(getPromptTimeoutMs(config))
    if (!msg) return { error: formatPromptTimeoutError(config) }

    const { images, text } = parseMessageImagesAndText(msg)
    if (images.length > 0) {
      for (const img of images) {
        collectedImages.push(img.attrs.src)
      }
    }

    if (text) {
      collectedText = text
    }

    if (mode === 'single') break
    if (collectedImages.length > 0 && collectedText) break
    if (collectedImages.length > 0) {
      await session.send(`已收到 ${collectedImages.length} 张图片，可继续发送或输入文字结束`)
    }
  }

  return { images: collectedImages, text: collectedText }
}
