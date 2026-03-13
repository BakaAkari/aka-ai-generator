import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UserManager } from './UserManager'

function assert(condition: any, message: string) {
  if (!condition) throw new Error(message)
}

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  }
}

async function testPendingQueueLimit() {
  const baseDir = mkdtempSync(join(tmpdir(), 'aka-ai-generator-'))
  const manager = new UserManager(baseDir, createLogger())

  try {
    const first = await manager.addPendingVideoTaskWithLimit({
      taskId: 'task-a',
      userId: 'u1',
      userName: 'tester',
      commandName: '图生视频',
      credits: 5,
      createdAt: new Date().toISOString(),
      charged: false
    }, 1)
    assert(first.success, '首个任务应成功入队')

    const second = await manager.addPendingVideoTaskWithLimit({
      taskId: 'task-b',
      userId: 'u1',
      userName: 'tester',
      commandName: '图生视频',
      credits: 5,
      createdAt: new Date().toISOString(),
      charged: false
    }, 1)
    assert(!second.success, '第二个任务应被队列上限拦截')

    await manager.markPendingVideoTaskCharged('task-a')
    await manager.deletePendingVideoTask('task-a')

    const third = await manager.addPendingVideoTaskWithLimit({
      taskId: 'task-c',
      userId: 'u1',
      userName: 'tester',
      commandName: '图生视频',
      credits: 5,
      createdAt: new Date().toISOString(),
      charged: false
    }, 1)
    assert(third.success, '结算并移除后应允许再次入队')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
}

function testVideoTaskLock() {
  const baseDir = mkdtempSync(join(tmpdir(), 'aka-ai-generator-'))
  const manager = new UserManager(baseDir, createLogger())

  try {
    assert(manager.startVideoTask('u1') === true, '首次加锁应成功')
    assert(manager.startVideoTask('u1') === false, '同用户重复加锁应失败')
    manager.endVideoTask('u1')
    assert(manager.startVideoTask('u1') === true, '释放锁后应可再次加锁')
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
}

async function main() {
  await testPendingQueueLimit()
  testVideoTaskLock()
  // eslint-disable-next-line no-console
  console.log('UserManager.spec passed')
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})

