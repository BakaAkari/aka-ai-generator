import { Session, h } from 'koishi'

export function collectImagesFromParamAndQuote(session: Session, imgParam: any): string[] {
  const images: string[] = []

  if (imgParam) {
    if (typeof imgParam === 'object' && imgParam.attrs?.src) {
      images.push(imgParam.attrs.src)
    } else if (typeof imgParam === 'string') {
      if (imgParam.startsWith('http') || imgParam.startsWith('data:')) {
        images.push(imgParam)
      }
    }
  }

  if (session.quote?.elements) {
    const quoteImages = h.select(session.quote.elements, 'img')
    for (const img of quoteImages) {
      if (img.attrs.src) images.push(img.attrs.src)
    }
  }

  return images
}

export function parseMessageImagesAndText(message: string) {
  const elements = h.parse(message)
  const images = h.select(elements, 'img')
  const text = h.select(elements, 'text').map(e => e.attrs.content).join(' ').trim()
  return { images, text }
}

