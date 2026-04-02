import { COMMANDS } from '../shared/constants'
import type { Config } from '../shared/config'
import type { ResolvedStyleConfig } from '../shared/types'

export interface CommandDefinition {
  name: string
  description: string
}

export interface CommandRegistry {
  userCommands: CommandDefinition[]
  adminCommands: CommandDefinition[]
}

function buildStyleCommandDefinitions(styleDefinitions: ResolvedStyleConfig[]): CommandDefinition[] {
  return styleDefinitions
    .filter(style => style.commandName && style.prompt)
    .map(style => ({
      name: style.commandName,
      description: style.description || '图像风格转换',
    }))
}

export function buildCommandRegistry(styleDefinitions: ResolvedStyleConfig[]): CommandRegistry {
  const styleCommands = buildStyleCommandDefinitions(styleDefinitions)
  const hasStyleTransferCommand = styleCommands.some(style => style.name === COMMANDS.STYLE_TRANSFER)

  return {
    userCommands: [
      { name: COMMANDS.TXT_TO_IMG, description: '根据文字描述生成图像' },
      { name: COMMANDS.IMG_TO_IMG, description: '使用自定义prompt进行图像处理（图生图）' },
      { name: COMMANDS.COMPOSE_IMAGE, description: '合成多张图片，使用自定义prompt控制合成效果' },
      ...(hasStyleTransferCommand
        ? []
        : [{ name: COMMANDS.STYLE_TRANSFER, description: '将第二张图片的视觉风格迁移至第一张图片' }]),
      ...styleCommands,
      { name: COMMANDS.QUERY_QUOTA, description: '查询用户额度信息' },
    ],
    adminCommands: [
      { name: COMMANDS.RECHARGE, description: '为用户充值次数（仅管理员）' },
      { name: COMMANDS.RECHARGE_ALL, description: '为所有用户充值次数（活动派发，仅管理员）' },
      { name: COMMANDS.RECHARGE_HISTORY, description: '查看充值历史记录（仅管理员）' },
    ],
  }
}

export function buildImageCommandsList(config: Config, commandRegistry: CommandRegistry, prefix: string, includeParams = true) {
  const lines = ['🎨 图像生成指令列表：\n']

  commandRegistry.userCommands
    .filter(cmd => config.showQuotaInImageCommands || cmd.name !== COMMANDS.QUERY_QUOTA)
    .forEach(cmd => {
      lines.push(`${prefix}${cmd.name} - ${cmd.description}`)
    })

  if (includeParams) {
    lines.push('\n🧩 图像参数说明：')
    lines.push('• -n <num> - 生成图片数量 (1-4)')
    lines.push('• -m - 允许多图输入（仅图生图指令支持）')
    lines.push('• -add <文本> - 追加用户自定义描述段')
    if (config.modelMappings?.length) {
      config.modelMappings.forEach(mapping => {
        if (!mapping?.suffix || !mapping?.modelId) return
        lines.push(`• -${mapping.suffix} - 图像生成模型切换为 ${mapping.modelId}`)
      })
    }
  } else {
    lines.push(`\n💡 使用 ${prefix}${COMMANDS.IMAGE_PARAMS} 查看完整的图像参数说明`)
  }

  return lines.join('\n')
}

export function buildImageParamsHelp(config: Config, prefix: string) {
  const lines = ['🧩 图像参数指令说明：\n']

  lines.push('📌 基础参数：')
  lines.push('• -n <num> - 生成图片数量 (1-4)，默认 1 张')
  lines.push('• -m - 允许多图输入（仅图生图指令支持）')
  lines.push('• -add <文本> - 追加用户自定义描述段到 prompt')

  lines.push('\n📐 宽高比参数：')
  lines.push('• -1:1 - 正方形 (1:1)')
  lines.push('• -4:3 - 标准横版 (4:3)')
  lines.push('• -16:9 - 宽屏横版 (16:9)')
  lines.push('• -3:2 - 相机横版 (3:2)')
  lines.push('• -9:16 - 竖屏 (9:16)')
  lines.push('• -2:3 - 相机竖版 (2:3)')

  lines.push('\n📏 分辨率/质量参数：')
  lines.push('• -1k - 低质量/低分辨率 (Gemini: LOW)')
  lines.push('• -2k - 中质量/中分辨率 (Gemini: MEDIUM)')
  lines.push('• -4k - 4K 高质量/高分辨率 (Gemini: 4K)')
  lines.push('• -<宽>x<高> - 自定义尺寸 (如 -1024x1536, -960x960)')
  lines.push('  注：自定义尺寸仅 GPT/Grok 模型支持')

  if (config.modelMappings?.length) {
    lines.push('\n🔄 模型切换参数：')
    config.modelMappings.forEach(mapping => {
      if (!mapping?.suffix || !mapping?.modelId) return
      const providerInfo = mapping.provider ? ` [${mapping.provider}]` : ''
      lines.push(`• -${mapping.suffix} - 切换至 ${mapping.modelId}${providerInfo}`)
    })
  }

  lines.push('\n💡 使用示例：')
  lines.push(`${prefix}文生图 -4k -16:9 一只猫在草地上`)
  lines.push(`${prefix}文生图 -1024x1536 一只猫`)
  lines.push(`${prefix}图生图 -m 将图片转换为动漫风格`)

  return lines.join('\n')
}

export function buildVideoCommandsList(config: Config, prefix: string) {
  const lines = ['🎥 视频生成指令列表：\n']

  lines.push(`${prefix}${COMMANDS.SINGLE_IMG_VIDEO} - 使用单张图片生成视频`)
  lines.push(`${prefix}${COMMANDS.MULTI_IMG_VIDEO} - 使用多张图片合成视频（人物+场景互动）`)
  lines.push(`${prefix}${COMMANDS.QUERY_VIDEO} - 根据任务ID查询视频状态`)

  if (config.videoStyles?.length > 0) {
    lines.push('\n📹 视频风格预设：')
    config.videoStyles.forEach(style => {
      lines.push(`${prefix}${style.commandName} - ${style.prompt.substring(0, 20)}...`)
    })
  }

  lines.push('\n🧩 视频参数说明：')
  lines.push('• -d <duration> - 视频时长（15 或 25 秒）')
  lines.push('• -r <ratio> - 宽高比（16:9, 9:16, 1:1）')
  lines.push('• -m - 使用多图模式（仅视频风格预设支持）')

  return lines.join('\n')
}
