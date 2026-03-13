import { Argv, h } from 'koishi'
import { ModelMappingConfig } from '../index'

interface StyleCommandModifiers {
  modelMapping?: ModelMappingConfig
  customAdditions?: string[]
}

/**
 * 规范化后缀名称
 */
export function normalizeSuffix(value?: string) {
  return value?.replace(/^\-+/, '').trim().toLowerCase()
}

/**
 * 构建模型映射索引
 */
export function buildModelMappingIndex(mappings?: ModelMappingConfig[]) {
  const map = new Map<string, ModelMappingConfig>()
  if (!Array.isArray(mappings)) return map
  for (const mapping of mappings) {
    const key = normalizeSuffix(mapping?.suffix)
    if (!key || !mapping?.modelId) continue
    map.set(key, mapping)
  }
  return map
}

/**
 * 解析风格命令修饰符
 */
export function parseStyleCommandModifiers(
  argv: Argv,
  imgParam: any,
  modelMappingIndex: Map<string, ModelMappingConfig>
): StyleCommandModifiers {
  // 优先从 session.content 解析原始文本，以支持被 Koishi 误吞的参数（如 -add, -4k）
  const session = argv.session
  let rawText = ''

  if (session?.content) {
    const elements = h.parse(session.content)
    // 提取所有文本节点
    rawText = h.select(elements, 'text').map(e => e.attrs.content).join(' ')
  }

  // 如果没有获取到 rawText，回退到原来的逻辑
  const argsList = rawText ? rawText.split(/\s+/).filter(Boolean) : [...(argv.args || [])].map(arg => typeof arg === 'string' ? arg.trim() : '').filter(Boolean)

  // 如果是回退逻辑，还需要处理 rest 和 imgParam
  if (!rawText) {
    const restStr = typeof argv.rest === 'string' ? argv.rest.trim() : ''
    if (restStr) {
      const restParts = restStr.split(/\s+/).filter(Boolean)
      argsList.push(...restParts)
    }

    if (imgParam && typeof imgParam === 'string' && !imgParam.startsWith('http') && !imgParam.startsWith('data:')) {
      const imgParts = imgParam.split(/\s+/).filter(Boolean)
      argsList.push(...imgParts)
    }
  }

  if (!argsList.length) return {}

  const modifiers: StyleCommandModifiers = { customAdditions: [] }
  const flagCandidates: string[] = []

  let index = 0
  while (index < argsList.length) {
    const token = argsList[index]
    if (!token) {
      index++
      continue
    }

    const lower = token.toLowerCase()

    // -add <文本...> 追加用户自定义段
    if (lower === '-add') {
      index++
      const additionTokens: string[] = []
      // 读取直到下一个以 - 开头的 flag 或结束
      while (index < argsList.length) {
        const nextToken = argsList[index]
        // 如果是 flag (以 - 开头)，且不是 -add (防止重复)，且在 mapping 中存在或者是已知 flag
        if (nextToken.startsWith('-')) {
          // 检查是否是有效的 flag
          const key = normalizeSuffix(nextToken)
          if (key && modelMappingIndex.has(key)) break
          if (nextToken.toLowerCase() === '-add') break
        }
        additionTokens.push(nextToken)
        index++
      }
      if (additionTokens.length) {
        modifiers.customAdditions!.push(additionTokens.join(' '))
      }
      continue
    }

    flagCandidates.push(token)
    index++
  }

  for (const arg of flagCandidates) {
    if (!arg.startsWith('-')) continue
    const key = normalizeSuffix(arg)
    if (!key) continue
    const mapping = modelMappingIndex.get(key)
    if (mapping) {
      modifiers.modelMapping = mapping
      break
    }
  }

  return modifiers
}

