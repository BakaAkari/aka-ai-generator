import { ImageProvider, ProviderConfig } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

export interface GeminiConfig extends ProviderConfig {
  apiKey: string
  modelId: string
  apiBase?: string
}

/**
 * 解析 Gemini 响应，提取图片 URL
 */
function parseGeminiResponse(response: any, logger?: any): string[] {
  try {
    const images: string[] = []
    
    logger?.debug('开始解析 Gemini API 响应', {
      hasResponse: !!response,
      responseType: typeof response,
      responseKeys: response ? Object.keys(response) : []
    })
    
    // 检查响应结构
    if (!response) {
      logger?.error('Gemini API 响应为空')
      return []
    }
    
    // 检查是否有错误信息
    if (response.error) {
      const sanitizedError = sanitizeError(response.error)
      logger?.error('Gemini API 返回错误', { error: sanitizedError })
      // 先清理错误对象，再转换为字符串
      const errorMessage = response.error.message || JSON.stringify(sanitizedError)
      const safeMessage = sanitizeString(errorMessage)
      throw new Error(`Gemini API 错误: ${safeMessage}`)
    }
    
    // 检查 promptFeedback，如果请求被阻止，响应中可能没有 candidates
    // 注意：部分第三方实现可能没有 promptFeedback，这里需要做空检查
    if (response.promptFeedback) {
      const blockReason = response.promptFeedback.blockReason
      const safetyRatings = response.promptFeedback.safetyRatings
      
      if (blockReason) {
        logger?.error('Gemini API 请求被阻止', { 
          blockReason, 
          safetyRatings,
          blockReasonMessage: response.promptFeedback.blockReasonMessage 
        })
        
        // 根据不同的 blockReason 提供更详细的错误信息
        let errorMessage = '请求被 Gemini API 阻止'
        
        switch (blockReason) {
          case 'SAFETY':
            errorMessage = '内容被安全策略阻止，可能包含不安全的内容'
            break
          case 'OTHER':
            errorMessage = '请求被阻止（原因：OTHER），可能是内容不符合使用政策或模型无法处理'
            if (response.promptFeedback.blockReasonMessage) {
              errorMessage += `：${response.promptFeedback.blockReasonMessage}`
            }
            break
          case 'RECITATION':
            errorMessage = '内容包含受版权保护的内容'
            break
          default:
            errorMessage = `请求被阻止（原因：${blockReason}）`
        }
        
        // 如果有安全评分信息，添加到错误消息中
        if (safetyRatings && Array.isArray(safetyRatings) && safetyRatings.length > 0) {
          const ratings = safetyRatings.map((r: any) => `${r.category}:${r.probability}`).join(', ')
          errorMessage += ` [安全评分: ${ratings}]`
        }
        
        throw new Error(errorMessage)
      }
    }
    
    if (response.candidates && response.candidates.length > 0) {
      logger?.debug('找到 candidates', { candidatesCount: response.candidates.length })
      
      for (let candIdx = 0; candIdx < response.candidates.length; candIdx++) {
        const candidate = response.candidates[candIdx]
        logger?.debug('处理 candidate', { 
          index: candIdx,
          hasContent: !!candidate.content,
          hasParts: !!candidate.content?.parts,
          partsCount: candidate.content?.parts?.length || 0,
          finishReason: candidate.finishReason
        })
        
        // 检查 finishReason，如果是 STOP 以外的值可能有错误
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
          logger?.warn('Gemini 响应 finishReason 异常', { 
            finishReason: candidate.finishReason,
            safetyRatings: candidate.safetyRatings 
          })
          
          // 如果是因为安全原因被阻止，抛出明确的错误
          if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'RECITATION') {
            throw new Error(`内容被阻止: ${candidate.finishReason}，可能包含不安全的内容`)
          }
          
          // 如果是其他原因（如最大token数），也记录警告
          if (candidate.finishReason !== 'MAX_TOKENS') {
            logger?.warn('Gemini 响应可能不完整', { finishReason: candidate.finishReason })
          }
        }
        
        if (candidate.content && candidate.content.parts) {
          logger?.debug('处理 candidate.content.parts', { 
            partsCount: candidate.content.parts.length,
            partsKeys: candidate.content.parts.map((p: any) => Object.keys(p))
          })
          
          for (let partIdx = 0; partIdx < candidate.content.parts.length; partIdx++) {
            const part = candidate.content.parts[partIdx]
            const partKeys = Object.keys(part)
            logger?.debug('处理 part', { 
              partIndex: partIdx,
              partKeys,
              hasInlineData: !!part.inlineData,
              hasInline_data: !!part.inline_data,
              hasFileData: !!part.fileData,
              hasText: !!part.text
            })
            
            // 检查是否有 inlineData（Base64 图片，驼峰命名）
            if (part.inlineData && part.inlineData.data) {
              const base64Data = part.inlineData.data
              const mimeType = part.inlineData.mimeType || 'image/jpeg'
              const dataUrl = `data:${mimeType};base64,${base64Data}`
              images.push(dataUrl)
              logger?.info('从响应中提取到图片 (inlineData)', { 
                mimeType, 
                dataLength: base64Data.length,
                dataUrlLength: dataUrl.length,
                imageIndex: images.length - 1
              })
            }
            // 兼容下划线命名
            else if (part.inline_data && part.inline_data.data) {
              const base64Data = part.inline_data.data
              const mimeType = part.inline_data.mime_type || 'image/jpeg'
              const dataUrl = `data:${mimeType};base64,${base64Data}`
              images.push(dataUrl)
              logger?.info('从响应中提取到图片 (inline_data)', { 
                mimeType, 
                dataLength: base64Data.length,
                dataUrlLength: dataUrl.length,
                imageIndex: images.length - 1
              })
            }
            // 检查是否有 fileData（文件引用）
            else if (part.fileData && part.fileData.fileUri) {
              images.push(part.fileData.fileUri)
              logger?.info('从响应中提取到图片 (fileData)', { 
                fileUri: part.fileData.fileUri,
                imageIndex: images.length - 1
              })
            }
            // 如果 part 只有 text，说明没有生成图片
            else if (part.text) {
              logger?.warn('响应中包含文本而非图片', { 
                text: part.text.substring(0, 100),
                textLength: part.text.length
              })
            } else {
              logger?.warn('part 中没有找到图片或文本数据', { 
                partKeys,
                part: JSON.stringify(part).substring(0, 200)
              })
            }
          }
        } else {
          logger?.warn('候选响应中没有 content.parts', { 
            candidateIndex: candIdx,
            candidateKeys: Object.keys(candidate),
            candidate: JSON.stringify(candidate).substring(0, 200) 
          })
        }
      }
    } else {
      // 如果没有 candidates，检查是否有其他有用的信息
      const hasPromptFeedback = !!response.promptFeedback
      const responseKeys = Object.keys(response)
      
      logger?.error('Gemini API 响应中没有 candidates', { 
        response: JSON.stringify(response).substring(0, 500),
        hasPromptFeedback,
        responseKeys 
      })
      
      // 如果没有 promptFeedback 也没有 candidates，这是异常情况
      if (!hasPromptFeedback) {
        throw new Error('Gemini API 响应格式异常：既没有生成内容也没有反馈信息')
      }
      
      // 如果有 promptFeedback 但没有 blockReason，也可能有问题
      if (hasPromptFeedback && !response.promptFeedback.blockReason) {
        logger?.warn('有 promptFeedback 但没有 blockReason，也没有 candidates', {
          promptFeedback: response.promptFeedback
        })
      }
    }
    
    logger?.debug('parseGeminiResponse 完成', {
      extractedImagesCount: images.length,
      hasCandidates: !!response.candidates,
      candidatesCount: response.candidates?.length || 0
    })
    
    if (images.length === 0) {
      logger?.error('未能从 Gemini API 响应中提取到任何图片', {
        hasCandidates: !!response.candidates,
        candidatesCount: response.candidates?.length || 0,
        responseKeys: Object.keys(response),
        firstCandidate: response.candidates?.[0] ? JSON.stringify(response.candidates[0]).substring(0, 500) : null,
        promptFeedback: response.promptFeedback ? JSON.stringify(response.promptFeedback) : null,
        fullResponse: JSON.stringify(response).substring(0, 1000)
      })
    }
    
    return images
  } catch (error: any) {
    const safeMessage = sanitizeString(error?.message || '未知错误')
    const safeStack = sanitizeString(error?.stack || '')
    logger?.error('解析 Gemini 响应时出错', { error: safeMessage, stack: safeStack })
    // 重新抛出错误，但使用清理后的消息
    const sanitizedError = new Error(safeMessage)
    sanitizedError.name = error?.name || 'Error'
    throw sanitizedError
  }
}

export class GeminiProvider implements ImageProvider {
  private config: GeminiConfig

  constructor(config: GeminiConfig) {
    this.config = config
  }

  async generateImages(
    prompt: string, 
    imageUrls: string | string[], 
    numImages: number,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>
  ): Promise<string[]> {
    // 处理空数组或空字符串的情况
    let urls: string[] = []
    if (Array.isArray(imageUrls)) {
      urls = imageUrls.filter(url => url && typeof url === 'string' && url.trim())
    } else if (imageUrls && typeof imageUrls === 'string' && imageUrls.trim()) {
      urls = [imageUrls]
    }
    
    const logger = this.config.logger
    const ctx = this.config.ctx
    
    logger.debug('开始处理图片输入', { urls, promptLength: prompt.length, isTextToImage: urls.length === 0 })
    
    // 下载所有图片并转换为 Base64
    const imageParts = []
    for (const url of urls) {
      if (!url || !url.trim()) continue
      
      try {
        const { data, mimeType } = await downloadImageAsBase64(
          ctx,
          url,
          this.config.apiTimeout,
          logger
        )
        imageParts.push({
          inline_data: {
            mime_type: mimeType,
            data: data
          }
        })
      } catch (error) {
        logger.error('处理输入图片失败，跳过该图片', { url, error: sanitizeError(error) })
        // 可以选择抛出错误，或者继续处理（这里选择继续，但记录错误）
      }
    }
    
    // API 基础地址
    const apiBase = this.config.apiBase?.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com'
    const endpoint = `${apiBase}/v1beta/models/${this.config.modelId}:generateContent`

    // 每次调用只能生成一张图片，需要循环调用
    const allImages: string[] = []
    
    for (let i = 0; i < numImages; i++) {
      // 构建 Gemini API 请求体
      const requestData = {
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              ...imageParts
            ]
          }
        ],
        generationConfig: {
          responseModalities: ["IMAGE"]
        }
      }
      
      logger.debug('调用 Gemini API', { prompt, imageCount: urls.length, numImages, current: i + 1, endpoint })
      
      try {
        const response = await ctx.http.post(
          endpoint,
          requestData,
          {
            headers: {
              'Content-Type': 'application/json'
            },
            params: {
              key: this.config.apiKey
            },
            timeout: this.config.apiTimeout * 1000
          }
        )
        
        const images = parseGeminiResponse(response, logger)
        
        if (images.length === 0) {
          // 即使解析到0张图片，也记录警告
          logger.warn('Gemini API 调用成功但未解析到图片', { 
            current: i + 1, 
            total: numImages,
            responseHasCandidates: !!response.candidates,
            responseKeys: Object.keys(response)
          })
          // 继续执行，不立即抛出错误，等待循环结束后统一处理
        } else {
          logger.success('Gemini API 调用成功', { current: i + 1, total: numImages, imagesCount: images.length })
          
          // 流式处理：每生成一张图片就立即调用回调
          logger.debug('开始流式处理图片', { 
            imagesCount: images.length,
            hasCallback: !!onImageGenerated,
            current: i + 1,
            total: numImages
          })
          
          for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
            const imageUrl = images[imgIdx]
            const currentIndex = allImages.length // 当前图片的全局索引
            allImages.push(imageUrl)
            
            logger.debug('准备处理单张图片', {
              imgIdx,
              currentIndex,
              total: numImages,
              imageUrlType: typeof imageUrl,
              imageUrlLength: imageUrl?.length || 0,
              imageUrlPrefix: imageUrl?.substring(0, 50) || 'null'
            })
            
            // 调用回调函数，立即发送图片
            if (onImageGenerated) {
              logger.info('准备调用图片生成回调函数', { 
                hasCallback: true,
                currentIndex,
                total: numImages,
                imageUrlLength: imageUrl?.length || 0
              })
              try {
                await onImageGenerated(imageUrl, currentIndex, numImages)
                logger.info('图片生成回调函数执行成功', { 
                  currentIndex, 
                  total: numImages,
                  imageUrlLength: imageUrl?.length || 0
                })
              } catch (callbackError) {
                logger.error('图片生成回调函数执行失败', { 
                  error: sanitizeError(callbackError),
                  errorMessage: callbackError?.message,
                  errorStack: callbackError?.stack,
                  currentIndex,
                  total: numImages,
                  imageUrlLength: imageUrl?.length || 0
                })
                // 回调失败不影响继续生成
              }
            } else {
              logger.warn('图片生成回调函数未提供，跳过流式发送', { 
                currentIndex,
                total: numImages,
                imageUrlLength: imageUrl?.length || 0
              })
            }
          }
          
          logger.debug('流式处理图片完成', {
            processedCount: images.length,
            allImagesCount: allImages.length
          })
        }
      } catch (error: any) {
        // 清理敏感信息后再记录日志
        const sanitizedError = sanitizeError(error)
        const safeMessage = typeof error?.message === 'string' ? sanitizeString(error.message) : '未知错误'
        
        logger.error('Gemini API 调用失败', { 
          message: safeMessage,
          code: error?.code,
          status: error?.response?.status,
          responseData: error?.response?.data ? sanitizeString(JSON.stringify(error.response.data).substring(0, 500)) : undefined,
          current: i + 1,
          total: numImages
        })
        // 如果已经生成了一些图片，返回已生成的
        if (allImages.length > 0) {
          logger.warn('部分图片生成失败，返回已生成的图片', { generated: allImages.length, requested: numImages })
          break
        }
        throw new Error(`图像处理API调用失败: ${safeMessage}`)
      }
    }
    
    // 如果最终没有生成任何图片，抛出明确的错误
    if (allImages.length === 0) {
      logger.error('所有 Gemini API 调用都未生成图片', { numImages })
      throw new Error('未能从 Gemini API 生成图片，请检查 prompt 和模型配置')
    }
    
    return allImages
  }
}
