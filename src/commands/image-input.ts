import type { Session } from 'koishi'
import type { Config } from '../shared/config'
import {
  formatPromptTimeoutError,
  getPromptTimeoutMs,
  getPromptTimeoutText,
} from '../shared/prompt-timeout'
import { collectImagesFromParamAndQuote, parseMessageImagesAndText } from '../utils/input'

export async function getStyleTransferImages(
  session: Session,
  config: Pick<Config, 'apiTimeout'>,
  imgParam: any,
): Promise<{ images: string[] } | { error: string }> {
  const collectedImages: string[] = collectImagesFromParamAndQuote(session, imgParam)

  if (collectedImages.length > 2) {
    return { error: '本功能仅支持两张图片，检测到多张图片' }
  }

  if (collectedImages.length === 2) {
    return { images: collectedImages }
  }

  await session.send(`请在${getPromptTimeoutText(config)}内依次发送两张图片：第一张为内容，第二张为风格`)

  while (collectedImages.length < 2) {
    const msg = await session.prompt(getPromptTimeoutMs(config))
    if (!msg) return { error: formatPromptTimeoutError(config) }

    const { images, text } = parseMessageImagesAndText(msg)

    if (images.length === 0) {
      return { error: text ? '未检测到图片，本功能需要两张图片' : '未检测到图片' }
    }

    for (const img of images) {
      if (img.attrs.src) collectedImages.push(img.attrs.src)
    }

    if (collectedImages.length > 2) {
      return { error: '本功能仅支持两张图片，检测到多张图片' }
    }

    if (collectedImages.length < 2) {
      await session.send(`已收到 ${collectedImages.length} 张图片，请继续发送第 ${collectedImages.length + 1} 张`)
    }
  }

  return { images: collectedImages }
}
