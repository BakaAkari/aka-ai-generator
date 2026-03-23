import type { Config } from './config'

export function getPromptTimeoutSeconds(config: Pick<Config, 'apiTimeout'>) {
  return Math.max(1, Math.round(config.apiTimeout))
}

export function getPromptTimeoutMs(config: Pick<Config, 'apiTimeout'>) {
  return getPromptTimeoutSeconds(config) * 1000
}

export function getPromptTimeoutText(config: Pick<Config, 'apiTimeout'>) {
  return `${getPromptTimeoutSeconds(config)}秒`
}

export function formatPromptTimeoutError(config: Pick<Config, 'apiTimeout'>, suffix = '') {
  return `等待超时（${getPromptTimeoutText(config)}）${suffix}`
}
