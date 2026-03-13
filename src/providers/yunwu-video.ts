import { VideoProvider, VideoTaskStatus, VideoGenerationOptions, ProviderConfig } from './types'
import { sanitizeError, sanitizeString, downloadImageAsBase64 } from './utils'

export interface YunwuVideoConfig extends ProviderConfig {
  apiKey: string
  modelId: string          // sora-2 或 sora-2-pro
  apiBase: string
}

export class YunwuVideoProvider implements VideoProvider {
  private config: YunwuVideoConfig

  constructor(config: YunwuVideoConfig) {
    this.config = config
  }

  /**
   * 创建视频生成任务
   * API: POST /v1/video/create
   */
  async createVideoTask(
    prompt: string,
    imageUrl: string,
    options?: VideoGenerationOptions
  ): Promise<string> {
    const { logger, ctx } = this.config

    try {
      // 1. 下载图片并转换为 Base64
      logger?.info('下载输入图片', { imageUrl })
      const { data: imageBase64, mimeType } = await downloadImageAsBase64(
        ctx,
        imageUrl,
        this.config.apiTimeout,
        logger
      )

      // 2. 将 aspectRatio 转换为 orientation
      // aspectRatio: "16:9" -> orientation: "landscape"
      // aspectRatio: "9:16" -> orientation: "portrait"
      // aspectRatio: "1:1" -> orientation: "portrait" (默认)
      let orientation: 'portrait' | 'landscape' = 'landscape'
      if (options?.aspectRatio === '9:16') {
        orientation = 'portrait'
      } else if (options?.aspectRatio === '1:1') {
        orientation = 'portrait' // 1:1 使用竖屏
      }

      // 3. 处理 duration：API 只支持 15 或 25 秒
      let duration = options?.duration || 15
      if (duration < 15) {
        duration = 15
      } else if (duration > 25) {
        duration = 25
      } else if (duration <= 20) {
        duration = 15
      } else {
        duration = 25
      }

      // 4. 构建请求体（根据云雾 API 文档）
      const buildRequestBody = (watermark: boolean) => ({
        images: [`data:${mimeType};base64,${imageBase64}`],
        model: this.config.modelId,
        orientation: orientation,
        prompt: prompt,
        size: 'large', // 高清1080p
        duration: duration,
        watermark, // 优先无水印；若接口不允许则降级有水印
        private: false // 默认视频会发布
      })

      logger?.info('提交视频生成任务', { 
        model: this.config.modelId,
        promptLength: prompt.length,
        duration,
        orientation
      })

      const doCreate = async (watermark: boolean) => {
        return await ctx.http.post(
          `${this.config.apiBase}/v1/video/create`,
          buildRequestBody(watermark),
          {
            headers: {
              'Authorization': `Bearer ${this.config.apiKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: this.config.apiTimeout * 1000
          }
        )
      }

      // 5. 调用 API：优先无水印；失败则降级有水印
      let response: any
      try {
        response = await doCreate(false)
      } catch (e: any) {
        logger?.warn('无水印创建任务失败，尝试有水印', { error: sanitizeError(e) })
        response = await doCreate(true)
      }

      // 如果 API 以“响应体 error/状态码”形式返回失败，也尝试降级
      if (response?.error || (response?.status && response.status >= 400)) {
        logger?.warn('无水印创建任务返回错误，尝试有水印', { status: response?.status, error: response?.error, response: response?.data })
        response = await doCreate(true)
      }

      // 6. 提取任务ID（根据文档，响应中的 id 字段）
      if (response.error) {
        const errorMsg = response.error.message || response.error.type || '创建任务失败'
        throw new Error(sanitizeString(errorMsg))
      }

      // 检查 HTTP 错误响应
      if (response.status && response.status >= 400) {
        const errorMsg = response.data?.error?.message || response.data?.error || response.statusText || '创建任务失败'
        logger?.error('API 返回错误状态', { status: response.status, error: errorMsg, response: response.data })
        throw new Error(sanitizeString(errorMsg))
      }

      // 根据文档，响应格式：
      // {
      //   id: string,  // 如 "sora-2:task_01k6x15vhrff09dkkqjrzwhm60"
      //   status: string,
      //   status_update_time: number
      // }
      const taskId = response.id
      if (!taskId) {
        logger?.error('未能获取任务ID', { response })
        throw new Error('未能获取任务ID，请检查 API 响应格式')
      }

      logger?.info('视频任务已创建', { taskId, status: response.status })
      return taskId

    } catch (error: any) {
      logger?.error('创建视频任务失败', { error: sanitizeError(error) })
      
      // 提取更详细的错误信息
      let errorMessage = error.message || '创建视频任务失败'
      
      // 如果是 HTTP 错误响应，尝试提取详细信息
      if (error.response) {
        const responseData = error.response.data
        if (responseData?.error) {
          errorMessage = responseData.error.message || responseData.error.type || errorMessage
        } else if (responseData?.message) {
          errorMessage = responseData.message
        }
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error.message || error.response.data.error.type || errorMessage
      }
      
      throw new Error(`创建视频任务失败: ${sanitizeString(errorMessage)}`)
    }
  }

  /**
   * 查询任务状态
   * API: GET /v1/video/query?id={taskId}
   */
  async queryTaskStatus(taskId: string): Promise<VideoTaskStatus> {
    const { logger, ctx } = this.config

    try {
      // 根据文档，查询端点使用查询参数 id
      const endpoint = `/v1/video/query?id=${encodeURIComponent(taskId)}`
      
      logger?.debug('查询任务状态', { taskId, endpoint })
      
      const response = await ctx.http.get(
        `${this.config.apiBase}${endpoint}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Accept': 'application/json'
          },
          timeout: this.config.apiTimeout * 1000
        }
      )

      // 根据文档，响应格式：
      // {
      //   id: string,
      //   status: string,
      //   video_url: string | null,
      //   enhanced_prompt: string,
      //   status_update_time: number
      // }
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
      
      // 提取错误信息
      let errorMessage = error.message || '查询任务失败'
      if (error.response?.data?.error) {
        errorMessage = error.response.data.error.message || error.response.data.error.type || errorMessage
      }
      
      throw new Error(`查询任务失败: ${sanitizeString(errorMessage)}`)
    }
  }

  /**
   * 轮询等待任务完成
   */
  private async pollTaskCompletion(
    taskId: string,
    maxWaitTime: number = 300,    // 5分钟
    pollInterval: number = 3,      // 每3秒查询一次
    onProgress?: (status: VideoTaskStatus) => void | Promise<void>
  ): Promise<string> {
    const { logger } = this.config
    const startTime = Date.now()
    let consecutiveFailures = 0  // 连续失败次数
    const maxConsecutiveFailures = 5  // 最大连续失败次数

    while (true) {
      const elapsed = (Date.now() - startTime) / 1000

      if (elapsed > maxWaitTime) {
        logger?.warn('视频生成超时', { taskId, elapsed, maxWaitTime })
        throw new Error(`视频生成超时（已等待${Math.floor(elapsed)}秒），任务ID: ${taskId}\n请使用"查询视频 ${taskId}"命令稍后查询结果`)
      }

      try {
        const status = await this.queryTaskStatus(taskId)
        consecutiveFailures = 0  // 重置失败计数
        logger?.debug('任务状态', { taskId, status: status.status, elapsed: Math.floor(elapsed) })

        // 调用进度回调
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
          error: sanitizeError(error),
          elapsed: Math.floor(elapsed)
        })

        // 如果连续失败次数超过阈值，才抛出错误
        if (consecutiveFailures >= maxConsecutiveFailures) {
          logger?.error('连续查询失败次数过多，终止轮询', { 
            taskId, 
            consecutiveFailures,
            elapsed: Math.floor(elapsed)
          })
          throw new Error(`查询任务状态连续失败 ${consecutiveFailures} 次，任务ID: ${taskId}\n请稍后使用"查询视频 ${taskId}"命令手动查询结果`)
        }

        // 单次查询失败，等待后继续重试（不立即抛出错误）
        // 等待时间稍微延长，避免频繁重试
        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000 * 2))
        continue
      }

      // 等待后继续查询
      await new Promise(resolve => setTimeout(resolve, pollInterval * 1000))
    }
  }

  /**
   * 等待指定任务完成并返回视频 URL（供外部在拿到 taskId 后自行控制扣费/提示）
   */
  async waitForVideo(taskId: string, maxWaitTime: number = 300): Promise<string> {
    return await this.pollTaskCompletion(taskId, maxWaitTime)
  }

  /**
   * 生成视频（主入口）
   */
  async generateVideo(
    prompt: string,
    imageUrl: string,
    options?: VideoGenerationOptions,
    maxWaitTime: number = 300
  ): Promise<string> {
    const { logger } = this.config

    try {
      logger?.info('开始生成视频', { prompt, imageUrl, options })

      // 1. 创建任务
      const taskId = await this.createVideoTask(prompt, imageUrl, options)

      // 2. 等待几秒后再开始查询（任务创建后需要一些时间才能查询到）
      logger?.debug('任务已创建，等待 3 秒后开始查询', { taskId })
      await new Promise(resolve => setTimeout(resolve, 3000))

      // 3. 轮询等待完成
      const videoUrl = await this.waitForVideo(taskId, maxWaitTime)

      logger?.info('视频生成完成', { taskId, videoUrl })
      return videoUrl

    } catch (error: any) {
      logger?.error('视频生成失败', { error: sanitizeError(error) })
      throw error
    }
  }
}

