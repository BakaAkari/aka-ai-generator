import { AI_GENERATOR_TOOL_DEFINITIONS } from '../../shared/chatluna-tool-definitions'
import type { AiGeneratorService } from '../../service/AiGeneratorService'
import { createChatLunaToolInstance, createStylePresetToolInstance } from './tool-runtime'
import type { ChatLunaPluginLike, StructuredToolConstructor } from './runtime'
import type { ChatLunaConfigAccessor, ChatLunaSessionLike } from './types'
import type { StyleConfig } from '../../shared/types'

export function registerChatLunaTools(
  plugin: ChatLunaPluginLike,
  StructuredTool: StructuredToolConstructor,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
  styles: StyleConfig[] = [],
) {
  // 注册基础工具
  for (const definition of AI_GENERATOR_TOOL_DEFINITIONS) {
    plugin.registerTool(definition.name, {
      selector() {
        return true
      },
      authorization(session: ChatLunaSessionLike) {
        return Boolean(session?.userId)
      },
      createTool() {
        return createChatLunaToolInstance(StructuredTool, definition, aiGenerator, getConfig)
      },
    })
  }

  // 为用户配置的每个 style 注册独立工具
  for (const style of styles) {
    const toolName = `aigc_style_${sanitizeToolName(style.commandName)}`
    plugin.registerTool(toolName, {
      selector() {
        return true
      },
      authorization(session: ChatLunaSessionLike) {
        return Boolean(session?.userId)
      },
      createTool() {
        return createStylePresetToolInstance(StructuredTool, style, aiGenerator, getConfig)
      },
    })
  }
}

function sanitizeToolName(name: string): string {
  // 将中文或特殊字符转换为合法的工具名（小写字母、数字、下划线）
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
}
