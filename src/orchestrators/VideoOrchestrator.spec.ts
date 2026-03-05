import { runVideoGenerationFlow } from './VideoOrchestrator'

function createMocks() {
  const calls = {
    addPending: [] as any[],
    markCharged: [] as any[],
    deletePending: [] as any[],
    recordUsage: [] as any[],
    sends: [] as any[],
  }

  const session = {
    username: 'tester',
    send: async (msg: any) => {
      calls.sends.push(msg)
    }
  } as any

  const userManager = {
    addPendingVideoTaskWithLimit: async (task: any) => {
      calls.addPending.push(task)
      return { success: true }
    },
    markPendingVideoTaskCharged: async (taskId: string) => {
      calls.markCharged.push(taskId)
      return null
    },
    deletePendingVideoTask: async (taskId: string) => {
      calls.deletePending.push(taskId)
    },
    endVideoTask: (_userId: string) => {}
  } as any

  const recordUserUsage = async (_session: any, commandName: string, credits: number) => {
    calls.recordUsage.push({ commandName, credits })
  }

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  }

  return { calls, session, userManager, recordUserUsage, logger }
}

async function testCompletedOnlyChargeOnce() {
  const { calls, session, userManager, recordUserUsage, logger } = createMocks()

  let queryCount = 0
  const videoProvider = {
    createVideoTask: async () => 'task-1',
    queryTaskStatus: async () => {
      queryCount += 1
      if (queryCount === 1) {
        return { status: 'processing' }
      }
      return { status: 'completed', videoUrl: 'https://video.example/1.mp4' }
    }
  } as any

  const result = await runVideoGenerationFlow({
    session,
    userId: 'u1',
    userManager,
    videoProvider,
    logger,
    sanitizeString: (s) => s,
    sanitizeError: (e) => e,
    recordUserUsage,
    commandName: '图生视频',
    prompt: 'prompt',
    imageUrl: 'https://img.example/1.png',
    videoCredits: 5,
    maxWaitTime: 0,
    startMessage: '开始生成视频...',
    videoOptions: { duration: 15, aspectRatio: '16:9' }
  })

  if (result !== '视频生成完成！') throw new Error('完成状态返回值异常')
  if (calls.recordUsage.length !== 1) throw new Error('应只扣费一次')
  if (calls.markCharged.length !== 1) throw new Error('应只标记一次 charged')
  if (calls.deletePending.length !== 1) throw new Error('应只删除一次 pending')
}

async function testFailedShouldNotCharge() {
  const { calls, session, userManager, recordUserUsage, logger } = createMocks()

  const videoProvider = {
    createVideoTask: async () => 'task-2',
    queryTaskStatus: async () => ({ status: 'failed', error: 'bad request' })
  } as any

  const result = await runVideoGenerationFlow({
    session,
    userId: 'u1',
    userManager,
    videoProvider,
    logger,
    sanitizeString: (s) => s,
    sanitizeError: (e) => e,
    recordUserUsage,
    commandName: '图生视频',
    prompt: 'prompt',
    imageUrl: 'https://img.example/1.png',
    videoCredits: 5,
    maxWaitTime: 0,
    startMessage: '开始生成视频...',
    videoOptions: { duration: 15, aspectRatio: '16:9' }
  })

  if (!String(result).includes('视频生成失败')) throw new Error('失败状态返回值异常')
  if (calls.recordUsage.length !== 0) throw new Error('失败任务不应扣费')
}

async function testQueueLimitDenied() {
  const { calls, session, recordUserUsage, logger } = createMocks()

  const userManager = {
    addPendingVideoTaskWithLimit: async () => ({ success: false, message: '队列已满' }),
    deletePendingVideoTask: async (_taskId: string) => {},
    endVideoTask: (_userId: string) => {}
  } as any

  const videoProvider = {
    createVideoTask: async () => 'task-3',
    queryTaskStatus: async () => ({ status: 'processing' })
  } as any

  const result = await runVideoGenerationFlow({
    session,
    userId: 'u1',
    userManager,
    videoProvider,
    logger,
    sanitizeString: (s) => s,
    sanitizeError: (e) => e,
    recordUserUsage,
    commandName: '图生视频',
    prompt: 'prompt',
    imageUrl: 'https://img.example/1.png',
    videoCredits: 5,
    maxWaitTime: 0,
    startMessage: '开始生成视频...',
    videoOptions: { duration: 15, aspectRatio: '16:9' }
  })

  if (result !== '队列已满') throw new Error('队列上限未生效')
  if (calls.recordUsage.length !== 0) throw new Error('队列拒绝不应扣费')
}

async function main() {
  await testCompletedOnlyChargeOnce()
  await testFailedShouldNotCharge()
  await testQueueLimitDenied()
  // eslint-disable-next-line no-console
  console.log('VideoOrchestrator.spec passed')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})

