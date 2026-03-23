import { AI_GENERATOR_TOOL_DEFINITIONS } from '../../shared/chatluna-tool-definitions'
import type { AiGeneratorService } from '../../service/AiGeneratorService'
import { createChatLunaToolInstance } from './tool-runtime'
import type { ChatLunaPluginLike, StructuredToolConstructor } from './runtime'
import type { ChatLunaConfigAccessor, ChatLunaSessionLike } from './types'

export function registerChatLunaTools(
  plugin: ChatLunaPluginLike,
  StructuredTool: StructuredToolConstructor,
  aiGenerator: AiGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
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
}
