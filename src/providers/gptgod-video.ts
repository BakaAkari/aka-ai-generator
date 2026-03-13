import { VideoProvider, VideoTaskStatus, VideoGenerationOptions, ProviderConfig } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

export type GPTGodVideoApiFormat = 'sora' | 'veo' | 'kling'

export interface GPTGodVideoConfig extends ProviderConfig {
  apiKey: string
  modelId?: string
  apiBase: string
  apiFormat: GPTGodVideoApiFormat
}

/**
 * GPTGod 视频生成 Provider
 * 支持 Sora、Veo、可灵
 * 明确不支持：海螺、Seedance
 */
export class GPTGodVideoProvider implements VideoProvider {
  private config: GPTGodVideoConfig

  constructor(config: GPTGodVideoConfig) {
    this.config = config
  }

  /**
   * 创建视频生成任务
   */
  async createVideoTask(
    prompt: string,
    imageUrls: string | string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { apiFormat } = this.config
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    
    // 明确不支持海螺和 Seedance
    if (apiFormat === 'hailuo' as any) {
      throw new Error('GPTGod 不支持海螺视频生成，请选择其他供应商')
    }
    if (apiFormat === 'seedance' as any) {
      throw new Error('GPTGod 不支持 Seedance 视频生成，请使用云雾供应商')
    }

    switch (apiFormat) {
      case 'sora':
        return this.createSoraTask(prompt, urls, options)
      case 'veo':
        return this.createVeoTask(prompt, urls, options)
      case 'kling':
        return this.createKlingTask(prompt, urls, options)
      default:
        throw new Error(`GPTGod 不支持的模型格式: ${apiFormat}`)
    }
  }

  /**
   * GPTGod Sora 视频生成
   * 使用视频统一格式
   */
  private async createSoraTask(
    prompt: string,
    imageUrls: string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { logger, ctx } = this.config

    try {
      // GPTGod Sora 只支持单图
      const primaryImageUrl = imageUrls[0]
      const hasMultipleImages = imageUrls.length > 1
      
      if (hasMultipleImages) {
        logger?.warn('GPTGod Sora 只支持单图，将使用第一张图片', { 
          totalImages: imageUrls.length 
        })
      }

      // 下载图片
      logger?.info('下载输入图片', { imageUrl: primaryImageUrl, totalImages: imageUrls.length })
      const { data: imageBase64, mimeType } = await downloadImageAsBase64(
        ctx,
        primaryImageUrl,
        this.config.apiTimeout,
        logger
      )

      const modelId = this.config.modelId || 'sora-2'
      
      const requestBody: any = {
        model: modelId,
        prompt: prompt,
        aspect_ratio: options?.aspectRatio || '16:9',
        image: `data:${mimeType};base64,${imageBase64}`
      }

      logger?.info('提交 GPTGod Sora 视频生成任务', { 
        model: modelId,
        promptLength: prompt.length,
        hasImage: true
      })

      const response = await ctx.http.post(
        `${this.config.apiBase}/sora-2/videos`,
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
        throw new Error('未能获取任务ID')
      }

      logger?.info('GPTGod Sora 视频任务已创建', { taskId, status: response.status })
      return taskId

    } catch (error: any) {
      logger?.error('创建 GPTGod Sora 视频任务失败', { error: sanitizeError(error) })
      throw new Error(`创建视频任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * GPTGod Veo 视频生成
   * 使用视频统一格式
   */
  private async createVeoTask(
    prompt: string,
    imageUrls: string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { logger, ctx } = this.config

    try {
      // 下载所有图片
      logger?.info('下载输入图片', { imageCount: imageUrls.length })
      
      const imageDataList = await Promise.all(
        imageUrls.map(async (url, idx) => {
          try {
            const { data, mimeType } = await downloadImageAsBase64(
              ctx,
              url,
              this.config.apiTimeout,
              logger
            )
            return { data, mimeType, success: true }
          } catch (error) {
            logger?.error(`下载第 ${idx + 1} 张图片失败`, { error: sanitizeError(error) })
            return { data: '', mimeType: '', success: false }
          }
        })
      )
      
      const validImages = imageDataList.filter(img => img.success)
      if (validImages.length === 0) {
        throw new Error('所有图片下载失败')
      }

      const modelId = this.config.modelId || 'veo3'

      const requestBody: any = {
        model: modelId,
        prompt: prompt,
        aspect_ratio: options?.aspectRatio || '16:9',
        images: validImages.map(({ data, mimeType }) => `data:${mimeType};base64,${data}`),
        enhance_prompt: options?.enhancePrompt ?? true
      }

      logger?.info('提交 GPTGod Veo 视频生成任务', { 
        model: modelId,
        promptLength: prompt.length
      })

      const response = await ctx.http.post(
        `${this.config.apiBase}/veo/videos`,
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
        throw new Error('未能获取任务ID')
      }

      logger?.info('GPTGod Veo 视频任务已创建', { taskId, status: response.status })
      return taskId

    } catch (error: any) {
      logger?.error('创建 GPTGod Veo 视频任务失败', { error: sanitizeError(error) })
      throw new Error(`创建视频任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * GPTGod 可灵视频生成
   * 使用官方格式
   */
  private async createKlingTask(
    prompt: string,
    imageUrls: string[],
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { logger, ctx } = this.config

    try {
      // 下载所有图片
      logger?.info('下载输入图片', { imageCount: imageUrls.length })
      
      const imageDataList = await Promise.all(
        imageUrls.map(async (url, idx) => {
          try {
            const { data, mimeType } = await downloadImageAsBase64(
              ctx,
              url,
              this.config.apiTimeout,
              logger
            )
            return { data, mimeType, success: true }
          } catch (error) {
            logger?.error(`下载第 ${idx + 1} 张图片失败`, { error: sanitizeError(error) })
            return { data: '', mimeType: '', success: false }
          }
        })
      )
      
      const validImages = imageDataList.filter(img => img.success)
      if (validImages.length === 0) {
        throw new Error('所有图片下载失败')
      }

      const primaryImage = validImages[0]
      const referenceImages = validImages.slice(1)

      const requestBody: any = {
        model_name: this.config.modelId || 'kling-v2-master',
        prompt: prompt,
        image: `data:${primaryImage.mimeType};base64,${primaryImage.data}`,
        mode: options?.mode || 'std',
        duration: String(options?.duration || 5),
        aspect_ratio: options?.aspectRatio || '16:9',
        multi_shot: options?.multiShot || false,
        sound: options?.sound || 'off'
      }

      // 添加参考图片
      if (referenceImages.length > 0) {
        requestBody.reference_images = referenceImages.map(img => ({
          image: `data:${img.mimeType};base64,${img.data}`,
          type: 'subject'
        }))
      }

      if (options?.cameraControl) {
        requestBody.camera_control = options.cameraControl
      }

      logger?.info('提交 GPTGod 可灵视频生成任务', { 
        model: requestBody.model_name,
        promptLength: prompt.length,
        mode: requestBody.mode,
        referenceImageCount: referenceImages.length
      })

      const response = await ctx.http.post(
        `${this.config.apiBase}/kling/v1/videos/image2video`,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.config.apiTimeout * 1000
        }
      )

      // 可灵响应格式
      if (response.code !== 0 && response.code !== undefined) {
        const errorMsg = response.message || '创建任务失败'
        throw new Error(sanitizeString(errorMsg))
      }

      const taskId = response.data?.task_id || response.task_id
      if (!taskId) {
        logger?.error('未能获取任务ID', { response })
        throw new Error('未能获取任务ID')
      }

      logger?.info('GPTGod 可灵视频任务已创建', { taskId })
      return String(taskId)

    } catch (error: any) {
      logger?.error('创建 GPTGod 可灵视频任务失败', { error: sanitizeError(error) })
      throw new Error(`创建视频任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * 查询任务状态
   */
  async queryTaskStatus(taskId: string): Promise<VideoTaskStatus> {
    const { apiFormat } = this.config
    
    switch (apiFormat) {
      case 'sora':
        return this.querySoraTaskStatus(taskId)
      case 'veo':
        return this.queryVeoTaskStatus(taskId)
      case 'kling':
        return this.queryKlingTaskStatus(taskId)
      default:
        throw new Error(`GPTGod 不支持的模型格式: ${apiFormat}`)
    }
  }

  /**
   * 查询 Sora 任务状态
   */
  private async querySoraTaskStatus(taskId: string): Promise<VideoTaskStatus> {
    const { logger, ctx } = this.config

    try {
      const response = await ctx.http.get(
        `${this.config.apiBase}/sora/videos/${encodeURIComponent(taskId)}`,
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
      logger?.error('查询 GPTGod Sora 任务状态失败', { taskId, error: sanitizeError(error) })
      throw new Error(`查询任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * 查询 Veo 任务状态
   */
  private async queryVeoTaskStatus(taskId: string): Promise<VideoTaskStatus> {
    const { logger, ctx } = this.config

    try {
      const response = await ctx.http.get(
        `${this.config.apiBase}/veo/videos/${encodeURIComponent(taskId)}`,
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
      logger?.error('查询 GPTGod Veo 任务状态失败', { taskId, error: sanitizeError(error) })
      throw new Error(`查询任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * 查询可灵任务状态
   */
  private async queryKlingTaskStatus(taskId: string): Promise<VideoTaskStatus> {
    const { logger, ctx } = this.config

    try {
      const response = await ctx.http.get(
        `${this.config.apiBase}/kling/v1/videos/${encodeURIComponent(taskId)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Accept': 'application/json'
          },
          timeout: this.config.apiTimeout * 1000
        }
      )

      const rawStatus = response.data?.task_status || response.task_status || 'pending'
      const videoUrl = response.data?.video_url || response.video_url || null

      const statusMap: Record<string, VideoTaskStatus['status']> = {
        'submitted': 'pending',
        'processing': 'processing',
        'succeed': 'completed',
        'failed': 'failed',
        'pending': 'pending'
      }

      return {
        status: statusMap[rawStatus] || 'pending',
        taskId: String(taskId),
        videoUrl: videoUrl || undefined,
        error: response.data?.task_error || response.message
      }

    } catch (error: any) {
      logger?.error('查询 GPTGod 可灵任务状态失败', { taskId, error: sanitizeError(error) })
      throw new Error(`查询任务失败: ${sanitizeString(error.message || '未知错误')}`)
    }
  }

  /**
   * 轮询等待任务完成
   */
  private async pollTaskCompletion(
    taskId: string,
    maxWaitTime: number = 300,
    pollInterval: number = 3,
    onProgress?: (status: VideoTaskStatus) => void | Promise<void>
  ): Promise<string> {
    const { logger } = this.config
    const startTime = Date.now()
    let consecutiveFailures = 0
    const maxConsecutiveFailures = 5

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000

      if (elapsed > maxWaitTime) {
        logger?.warn('视频生成超时', { taskId, elapsed, maxWaitTime })
        throw new Error(`视频生成超时（已等待${Math.floor(elapsed)}秒），任务ID: ${taskId}`)
      }

      try {
        const status = await this.queryTaskStatus(taskId)
        consecutiveFailures = 0
        logger?.debug('任务状态', { taskId, status: status.status, elapsed: Math.floor(elapsed) })

        if (onProgress) {
          await onProgress(status)
        }

        if (status.status === 'completed' && status.videoUrl) {
          logger?.info('视频生成完成', { taskId, elapsed: Math.floor(elapsed) })
          return status.videoUrl
        }

        if (status.status === 'failed') {
          throw new Error(status.error || '视频生成失败')
        }

      } catch (error: any) {
        consecutiveFailures++
        logger?.warn('查询任务状态失败，继续重试', { 
          taskId, 
          consecutiveFailures,
          maxConsecutiveFailures,
          error: sanitizeError(error)
        })

        if (consecutiveFailures >= maxConsecutiveFailures) {
          logger?.error('连续查询失败次数过多，终止轮询', { 
            taskId, 
            consecutiveFailures,
            elapsed: Math.floor(elapsed)
          })
          throw new Error(`查询任务状态连续失败 ${consecutiveFailures} 次，任务ID: ${taskId}`)
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000 * 2))
        continue
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval * 1000))
    }
  }

  /**
   * 等待指定任务完成并返回视频 URL
   */
  async waitForVideo(taskId: string, maxWaitTime: number = 300): Promise<string> {
    return await this.pollTaskCompletion(taskId, maxWaitTime)
  }

  /**
   * 生成视频（主入口）
   */
  async generateVideo(
    prompt: string,
    imageUrls: string | string[],
    options?: VideoGenerationOptions,
    maxWaitTime: number = 300
  ): Promise<string> {
    const { logger } = this.config
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]

    try {
      logger?.info('开始生成视频（GPTGod）', { 
        prompt, 
        imageCount: urls.length,
        options,
        apiFormat: this.config.apiFormat
      })

      // 1. 创建任务
      const taskId = await this.createVideoTask(prompt, urls, options)

      // 2. 等待几秒后再开始查询
      logger?.debug('任务已创建，等待 3 秒后开始查询', { taskId })
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 3. 轮询等待完成
      const videoUrl = await this.waitForVideo(taskId, maxWaitTime)

      logger?.info('视频生成完成（GPTGod）', { taskId, videoUrl })
      return videoUrl

    } catch (error: any) {
      logger?.error('视频生成失败（GPTGod）', { error: sanitizeError(error) })
      throw error
    }
  }
}
