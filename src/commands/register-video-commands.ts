import type { Context, Session } from 'koishi'
import { COMMANDS } from '../shared/constants'
import type { Config } from '../shared/config'
import type { UserManager } from '../services/UserManager'
import type { VideoProvider } from '../providers/video-index'
import { executeVideoGenerationCommand, queryVideoTasks } from './video-runtime'

interface RegisterVideoCommandsParams {
  ctx: Context
  config: Config
  logger: ReturnType<Context['logger']>
  userManager: UserManager
  videoProvider: VideoProvider | null
  sanitizeString: (message: string) => string
  sanitizeError: (error: unknown) => unknown
  recordUserUsage: (session: Session, commandName: string, numImages?: number, sendStatsImmediately?: boolean) => Promise<void>
  getSessionUserName: (session?: Pick<Session, 'userId' | 'username'> | null) => string
}

export function registerVideoCommands(params: RegisterVideoCommandsParams) {
  const {
    ctx,
    config,
    logger,
    userManager,
    videoProvider,
    sanitizeString,
    sanitizeError,
    recordUserUsage,
    getSessionUserName,
  } = params
  const runtimeDeps = {
    config,
    logger,
    userManager,
    videoProvider,
    sanitizeString,
    sanitizeError,
    recordUserUsage,
    getSessionUserName,
  }

  if (config.enableVideoGeneration && videoProvider) {
    ctx.command(`${COMMANDS.SINGLE_IMG_VIDEO} [img:text]`, '使用单张图片生成视频')
      .option('duration', '-d <duration:number> 视频时长（15 或 25 秒）')
      .option('ratio', '-r <ratio:string> 宽高比（16:9, 9:16, 1:1）')
      .action(async ({ session, options }, img) => {
        const duration = options?.duration || 15
        if (duration !== 15 && duration !== 25) {
          return '视频时长必须是 15 或 25 秒'
        }

        const ratio = options?.ratio || '16:9'
        const validRatios = ['16:9', '9:16', '1:1']
        if (!validRatios.includes(ratio)) {
          return `宽高比必须是以下之一: ${validRatios.join(', ')}`
        }

        return executeVideoGenerationCommand(runtimeDeps, session, img, {
          commandName: COMMANDS.SINGLE_IMG_VIDEO,
          startMessage: '开始生成单图视频...',
          duration,
          aspectRatio: ratio,
          askPromptIfEmpty: true,
          mode: 'single',
        })
      })
  }

  if (config.enableVideoGeneration && videoProvider) {
    ctx.command(`${COMMANDS.MULTI_IMG_VIDEO} [img:text]`, '使用多张图片合成视频（人物+场景互动）')
      .option('duration', '-d <duration:number> 视频时长（15 或 25 秒）')
      .option('ratio', '-r <ratio:string> 宽高比（16:9, 9:16, 1:1）')
      .action(async ({ session, options }, img) => {
        const duration = options?.duration || 15
        if (duration !== 15 && duration !== 25) {
          return '视频时长必须是 15 或 25 秒'
        }

        const ratio = options?.ratio || '16:9'
        const validRatios = ['16:9', '9:16', '1:1']
        if (!validRatios.includes(ratio)) {
          return `宽高比必须是以下之一: ${validRatios.join(', ')}`
        }

        return executeVideoGenerationCommand(runtimeDeps, session, img, {
          commandName: COMMANDS.MULTI_IMG_VIDEO,
          startMessage: '开始生成多图合成视频...',
          duration,
          aspectRatio: ratio,
          askPromptIfEmpty: true,
          mode: 'multiple',
        })
      })
  }

  if (config.enableVideoGeneration && videoProvider) {
    ctx.command(`${COMMANDS.QUERY_VIDEO} [taskId:string]`, '查询视频生成状态（不传任务ID则查询自己所有待生成任务）')
      .action(async ({ session }, taskId) => queryVideoTasks(runtimeDeps, session, taskId))
  }

  if (config.enableVideoGeneration && videoProvider && config.videoStyles?.length > 0) {
    for (const style of config.videoStyles) {
      if (!style.commandName || !style.prompt) continue

      ctx.command(`${style.commandName} [img:text]`, '视频风格转换（单图）')
        .option('multi', '-m 使用多图模式')
        .action(async ({ session, options }, img) => {
          return executeVideoGenerationCommand(runtimeDeps, session, img, {
            commandName: style.commandName,
            startMessage: `开始生成视频（${style.commandName}）...`,
            basePrompt: style.prompt,
            duration: style.duration || 15,
            aspectRatio: style.aspectRatio || '16:9',
            askPromptIfEmpty: false,
            mode: options?.multi ? 'multiple' : 'single',
          })
        })

      logger.info(`已注册视频风格命令: ${style.commandName}`)
    }
  }
}
