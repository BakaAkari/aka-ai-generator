import { createRequire } from 'node:module'
import type { Context } from 'koishi'

export interface ChatLunaServiceLike {
  installPlugin(plugin: unknown): Promise<void> | void
  uninstallPlugin(plugin: unknown): void
  getPlugin?(name: string): unknown
}

export interface ChatLunaPluginLike {
  registerTool(name: string, tool: unknown): void
  dispose?(): Promise<void> | void
}

export type ChatLunaPluginConstructor = new (
  ctx: Context,
  config: Record<string, never>,
  platformName: string,
  createConfigPool: boolean,
) => ChatLunaPluginLike

export type StructuredToolConstructor = new (...args: any[]) => {
  name?: string
  description?: string
  schema?: unknown
  _call(input: Record<string, unknown>, runManager?: unknown, config?: { configurable?: { session?: unknown } }): Promise<string>
}

const runtimeRequire = createRequire(`${process.cwd()}/package.json`)

export async function loadChatLunaRuntime(): Promise<{
  ChatLunaPlugin: ChatLunaPluginConstructor
  StructuredTool: StructuredToolConstructor
}> {
  const [chatlunaModule, langchainToolsModule] = await Promise.all([
    loadRuntimeModule('koishi-plugin-chatluna/services/chat'),
    loadRuntimeModule('@langchain/core/tools'),
  ])

  const ChatLunaPlugin = chatlunaModule.ChatLunaPlugin as ChatLunaPluginConstructor | undefined
  const StructuredTool = langchainToolsModule.StructuredTool as StructuredToolConstructor | undefined

  if (!ChatLunaPlugin) {
    throw new Error('ChatLunaPlugin export not found from koishi-plugin-chatluna/services/chat.')
  }
  if (!StructuredTool) {
    throw new Error('StructuredTool export not found from @langchain/core/tools.')
  }

  return { ChatLunaPlugin, StructuredTool }
}

async function loadRuntimeModule(specifier: string): Promise<Record<string, any>> {
  try {
    return runtimeRequire(specifier) as Record<string, any>
  } catch (requireError) {
    const dynamicImport = new Function('s', 'return import(s)') as (target: string) => Promise<Record<string, any>>
    return dynamicImport(specifier).catch((importError) => {
      const requireMessage = requireError instanceof Error ? requireError.message : String(requireError)
      const importMessage = importError instanceof Error ? importError.message : String(importError)
      throw new Error(`failed to load runtime module "${specifier}"; require: ${requireMessage}; import: ${importMessage}`)
    })
  }
}
