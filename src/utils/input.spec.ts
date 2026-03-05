import { h } from 'koishi'
import { collectImagesFromParamAndQuote, parseMessageImagesAndText } from './input'

function assert(condition: any, message: string) {
  if (!condition) throw new Error(message)
}

async function testCollectFromParamObjectAndQuote() {
  const session = {
    quote: {
      elements: [
        h.image('https://img.example/q1.png'),
        h('text', { content: 'quoted' }),
        h.image('https://img.example/q2.png')
      ]
    }
  } as any

  const imgParam = h.image('https://img.example/p1.png')
  const result = collectImagesFromParamAndQuote(session, imgParam)

  assert(result.length === 3, '应收集参数图 + 引用图共 3 张')
  assert(result[0] === 'https://img.example/p1.png', '参数图片收集异常')
  assert(result[1] === 'https://img.example/q1.png', '引用图片1收集异常')
  assert(result[2] === 'https://img.example/q2.png', '引用图片2收集异常')
}

async function testCollectFromStringAndIgnoreInvalid() {
  const session = { quote: null } as any

  const httpResult = collectImagesFromParamAndQuote(session, 'https://img.example/a.png')
  assert(httpResult.length === 1, 'http 字符串图片应被收集')

  const dataResult = collectImagesFromParamAndQuote(session, 'data:image/png;base64,abc')
  assert(dataResult.length === 1, 'data url 图片应被收集')

  const invalidResult = collectImagesFromParamAndQuote(session, 'not-an-image')
  assert(invalidResult.length === 0, '无效字符串不应被收集')
}

async function testParseMessageImagesAndText() {
  const message = [
    h('text', { content: 'hello' }),
    h.image('https://img.example/1.png'),
    h('text', { content: 'world' }),
    h.image('https://img.example/2.png')
  ].join('')

  const { images, text } = parseMessageImagesAndText(message)
  assert(images.length === 2, '消息中应解析到 2 张图片')
  assert(images[0].attrs.src === 'https://img.example/1.png', '第一张图片解析异常')
  assert(images[1].attrs.src === 'https://img.example/2.png', '第二张图片解析异常')
  assert(text === 'hello world', '文本拼接解析异常')
}

async function main() {
  await testCollectFromParamObjectAndQuote()
  await testCollectFromStringAndIgnoreInvalid()
  await testParseMessageImagesAndText()
  // eslint-disable-next-line no-console
  console.log('input.spec passed')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})

