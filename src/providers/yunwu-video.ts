import { VideoProvider, VideoTaskStatus, VideoGenerationOptions, ProviderConfig } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

export interface YunwuVideoConfig extends ProviderConfig {
  apiKey: string
  modelId: string
  apiBase: string
  multiImageModelId?: string  // 多图生成视频专用模型ID
}

export class YunwuVideoProvider implements VideoProvider {
  private config: YunwuVideoConfig

  constructor(config: YunwuVideoConfig) {
    this.config = config
  }

  /**
   * 创建视频生成任务
   * 根据图片数量选择单图或多图模型
   */
  async createVideoTask(
    prompt: string,
    imageUrls: string | string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const hasMultipleImages = urls.length > 1
    
    // 如果有多张图片且配置了多图模型ID，使用多图模式
    if (hasMultipleImages && this.config.multiImageModelId) {
      return this.createMultiImageTask(prompt, urls, options)
    }
    
    // 单图模式使用单图模型
    return this.createSingleImageTask(prompt, urls, options)
  }

  /**
   * 单图视频生成（通用实现）
   */
  private async createSingleImageTask(
    prompt: string,
    imageUrls: string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { logger, ctx, modelId } = this.config

    if (!modelId) {
      throw new Error('未配置单图生成视频模型ID')
    }

    try {
      const primaryImageUrl = imageUrls[0]
      
      // 1. 下载图片并转换为 Base64
      logger?.info('【单图模式】下载输入图片', { imageUrl: primaryImageUrl })
      const { data: imageBase64, mimeType } = await downloadImageAsBase64(
        ctx,
        primaryImageUrl,
        this.config.apiTimeout,
        logger
      )

      // 2. 构建请求体
      const requestBody: any = {
        model: modelId,
        prompt: prompt,
        images: [`data:${mimeType};base64,${imageBase64}`],
        aspect_ratio: options?.aspectRatio || '16:9'
      }

      // 添加可选参数
      if (options?.duration) {
        requestBody.duration = options.duration
      }

      logger?.info('【单图模式】提交视频生成任务', { 
        model: modelId,
        promptLength: prompt.length,
        aspectRatio: requestBody.aspect_ratio
      })

      const response = await ctx.http.post(
        `${this.config.apiBase}/v1/video/create`,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: this.config.apiTimeout * 1000
        }
      )

      if (response.error) {
        const errorMsg = response.error.message || response.error.type || '创建任务失败'
        throw new Error(sanitizeString(errorMsg))
      }

      const taskId = response.id
      if (!taskId) {
        logger?.error('未能获取任务ID', { response })
        throw new Error('未能获取任务ID，请检查 API 响应格式')
      }

      logger?.info('【单图模式】视频任务已创建', { taskId, model: modelId })
      return taskId

    } catch (error: any) {
      logger?.error('【单图模式】创建视频任务失败', { error: sanitizeError(error), model: modelId })
      throw new Error(`创建视频任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * 多图生成视频任务
   * 使用专门的多图模型
   */
  private async createMultiImageTask(
    prompt: string,
    imageUrls: string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { logger, ctx, multiImageModelId } = this.config

    if (!multiImageModelId) {
      throw new Error('未配置多图生成视频模型ID')
    }

    try {
      logger?.info('【多图模式】下载输入图片', { imageCount: imageUrls.length, model: multiImageModelId })
      
      const imageDataList = await Promise.all(
        imageUrls.map(async (url, idx) => {
          try {
            const { data, mimeType } = await downloadImageAsBase64(
              ctx,
              url,
              this.config.apiTimeout,
              logger
            )
            return { data, mimeType, index: idx, success: true }
          } catch (error) {
            logger?.error(`下载第 ${idx + 1} 张图片失败`, { url, error: sanitizeError(error) })
            return { data: '', mimeType: '', index: idx, success: false }
          }
        })
      )
      
      const validImages = imageDataList.filter(img => img.success)
      if (validImages.length === 0) {
        throw new Error('所有图片下载失败')
      }
      
      if (validImages.length < imageUrls.length) {
        logger?.warn('部分图片下载失败，将使用剩余图片继续', { 
          total: imageUrls.length, 
          success: validImages.length 
        })
      }

      // 构建请求体 - 使用多图模型
      const requestBody: any = {
        model: multiImageModelId,
        prompt: prompt,
        images: validImages.map(({ data, mimeType }) => `data:${mimeType};base64,${data}`),
        aspect_ratio: options?.aspectRatio || '16:9'
      }

      // 添加可选参数
      if (options?.duration) {
        requestBody.duration = options.duration
      }

      logger?.info('【多图模式】提交视频生成任务', { 
        model: multiImageModelId,
        promptLength: prompt.length,
        imageCount: validImages.length,
        aspectRatio: requestBody.aspect_ratio
      })

      const response = await ctx.http.post(
        `${this.config.apiBase}/v1/video/create`,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: this.config.apiTimeout * 1000
        }
      )

      if (response.error) {
        const errorMsg = response.error.message || response.error.type || '创建任务失败'
        throw new Error(sanitizeString(errorMsg))
      }

      const taskId = response.id || response.data?.task_id
      if (!taskId) {
        logger?.error('未能获取任务ID', { response })
        throw new Error('未能获取任务ID')
      }

      logger?.info('【多图模式】视频任务已创建', { taskId, model: multiImageModelId })
      return String(taskId)

    } catch (error: any) {
      logger?.error('【多图模式】创建视频任务失败', { error: sanitizeError(error), model: multiImageModelId })
      throw new Error(`创建多图视频任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * 生成视频（包含轮询等待）
   * @returns 视频URL
   */
  async generateVideo(
    prompt: string,
    imageUrls: string | string[],
    options?: VideoGenerationOptions,
    maxWaitTime?: number
  ): Promise<string> {
    const { logger } = this.config
    const waitTime = maxWaitTime || 300 // 默认5分钟
    const pollInterval = 5000 // 5秒轮询一次
    const maxAttempts = Math.ceil(waitTime * 1000 / pollInterval)

    // 1. 创建任务
    const taskId = await this.createVideoTask(prompt, imageUrls, options)
    logger?.info('视频任务已创建，开始轮询', { taskId, maxWaitTime: waitTime })

    // 2. 轮询等待结果
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))
      
      const status = await this.queryTaskStatus(taskId)
      logger?.debug('轮询任务状态', { taskId, status: status.status, attempt })

      if (status.status === 'completed') {
        if (status.videoUrl) {
          logger?.info('视频生成完成', { taskId, videoUrl: status.videoUrl })
          return status.videoUrl
        }
        throw new Error('视频已完成但未返回视频URL')
      }

      if (status.status === 'failed') {
        throw new Error(status.error || '视频生成失败')
      }
    }

    throw new Error(`等待超时，任务ID: ${taskId}`)
  }

  /**
   * 查询任务状态
   */
  async queryTaskStatus(taskId: string): Promise<VideoTaskStatus> {
    const { logger, ctx } = this.config

    try {
      const response = await ctx.http.get(
        `${this.config.apiBase}/v1/video/query?id=${encodeURIComponent(taskId)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Accept': 'application/json'
          },
          timeout: this.config.apiTimeout * 1000
        }
      )

      const status = response.status || 'pending'
      const videoUrl = response.video_url || null

      return {
        status: status as VideoTaskStatus['status'],
        taskId: response.id || taskId,
        videoUrl: videoUrl || undefined,
        error: response.error,
        progress: response.progress
      }

    } catch (error: any) {
      logger?.error('查询任务状态失败', { taskId, error: sanitizeError(error) })
      throw new Error(`查询任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }
}
