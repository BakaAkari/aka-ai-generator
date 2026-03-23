import type { Context, Session } from 'koishi'
import {
  buildImageCommandsList,
  buildVideoCommandsList,
  type CommandRegistry,
} from './catalog'
import {
  handleQueryQuotaCommand,
  handleRechargeAllCommand,
  handleRechargeCommand,
  handleRechargeHistoryCommand,
} from './management-runtime'
import { COMMANDS } from '../shared/constants'
import type { Config } from '../shared/config'
import type { UserManager } from '../services/UserManager'

interface RegisterManagementCommandsParams {
  ctx: Context
  config: Config
  logger: ReturnType<Context['logger']>
  userManager: UserManager
  commandRegistry: CommandRegistry
  getPromptInput: (session: Session, message: string) => Promise<string | null>
  getConfiguredPrefix: () => string
}

export function registerManagementCommands(params: RegisterManagementCommandsParams) {
  const {
    ctx,
    config,
    logger,
    userManager,
    commandRegistry,
    getPromptInput,
    getConfiguredPrefix,
  } = params
  const runtimeDeps = {
    config,
    logger,
    userManager,
    getPromptInput,
  }

  ctx.command(`${COMMANDS.RECHARGE} [content:text]`, '为用户充值次数（仅管理员）')
    .action(async ({ session }, content) => handleRechargeCommand(runtimeDeps, session, content))

  ctx.command(`${COMMANDS.RECHARGE_ALL} [content:text]`, '为所有用户充值次数（活动派发，仅管理员）')
    .action(async ({ session }, content) => handleRechargeAllCommand(runtimeDeps, session, content))

  ctx.command(`${COMMANDS.QUERY_QUOTA} [target:text]`, '查询用户额度信息')
    .action(async ({ session }, target) => handleQueryQuotaCommand(runtimeDeps, session, target))

  ctx.command(`${COMMANDS.RECHARGE_HISTORY} [page:number]`, '查看充值历史记录（仅管理员）')
    .action(async ({ session }, page = 1) => handleRechargeHistoryCommand(runtimeDeps, session, page))

  ctx.command(COMMANDS.IMAGE_COMMANDS, '查看图像生成指令列表')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      return buildImageCommandsList(config, commandRegistry, getConfiguredPrefix())
    })

  ctx.command(COMMANDS.VIDEO_COMMANDS, '查看视频生成指令列表')
    .action(async ({ session }) => {
      if (!session?.userId) return '会话无效'
      if (!config.enableVideoGeneration) {
        return '视频生成功能未启用'
      }
      return buildVideoCommandsList(config, getConfiguredPrefix())
    })
}
