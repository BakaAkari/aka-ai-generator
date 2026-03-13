import { sanitizeError, sanitizeString } from './utils'

function assert(condition: any, message: string) {
  if (!condition) throw new Error(message)
}

function testSanitizeString() {
  const input = 'authorization=Bearer sk-12345678901234567890 and api_key=abcdef1234567890'
  const output = sanitizeString(input)

  assert(!output.includes('sk-12345678901234567890'), 'sanitizeString 未脱敏 Bearer token')
  assert(!output.includes('abcdef1234567890'), 'sanitizeString 未脱敏 api_key')
  assert(output.includes('[REDACTED]') || output.includes('[REDACTED-SK]'), 'sanitizeString 输出未包含脱敏标记')
}

function testSanitizeErrorObject() {
  const input = {
    apiKey: 'abc1234567890',
    nested: {
      token: 'tok1234567890'
    },
    normal: 'ok'
  }

  const output = sanitizeError(input)
  assert(output.apiKey === '[REDACTED]', 'sanitizeError 未脱敏 apiKey 字段')
  assert(output.nested.token === '[REDACTED]', 'sanitizeError 未脱敏 nested.token 字段')
  assert(output.normal === 'ok', 'sanitizeError 错误修改了普通字段')
}

function main() {
  testSanitizeString()
  testSanitizeErrorObject()
  // eslint-disable-next-line no-console
  console.log('utils.spec passed')
}

main()

