'use strict'

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '../../data')
const PERSIST_FILE = path.join(DATA_DIR, 'cron-jobs.json')

// 内存存储
const cronJobs = new Map()
let nextId = 1

// --- 持久化 ---

function saveToDisk() {
  const jobs = Array.from(cronJobs.values()).map(job => ({
    id: job.id,
    spec: job.spec,
    prompt: job.prompt,
    chatId: job.chatId,
    userId: job.userId,
    createdAt: job.createdAt,
  }))
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
    }
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(jobs, null, 2), 'utf-8')
  } catch (err) {
    console.error('[cron] Failed to save jobs:', err.message)
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return []
    const data = fs.readFileSync(PERSIST_FILE, 'utf-8')
    return JSON.parse(data)
  } catch (err) {
    console.error('[cron] Failed to load jobs:', err.message)
    return []
  }
}

// --- Cron 表达式解析 ---

/**
 * 解析简单间隔格式：5m, 30m, 1h, 2h
 * @returns {number|null} 毫秒间隔，或 null 表示不是简单间隔
 */
function parseInterval(spec) {
  const match = spec.match(/^(\d+)(m|h)$/i)
  if (!match) return null
  const value = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  if (unit === 'm') return value * 60 * 1000
  if (unit === 'h') return value * 3600 * 1000
  return null
}

/**
 * 解析 cron 字段，支持：* / 数字 / 范围 1-5 / 列表 1,3,5 / 步长 *\/5
 */
function parseCronField(field, min, max) {
  // *
  if (field === '*') return () => true

  // */N 步长
  const stepMatch = field.match(/^\*\/(\d+)$/)
  if (stepMatch) {
    const step = parseInt(stepMatch[1], 10)
    return (val) => val % step === 0
  }

  // 逗号分隔的列表，每项可以是数字或范围（可带步长）
  const parts = field.split(',')
  const allowed = new Set()

  for (const part of parts) {
    // 范围带步长：1-10/2
    const rangeStepMatch = part.match(/^(\d+)-(\d+)\/(\d+)$/)
    if (rangeStepMatch) {
      const start = parseInt(rangeStepMatch[1], 10)
      const end = parseInt(rangeStepMatch[2], 10)
      const step = parseInt(rangeStepMatch[3], 10)
      for (let i = start; i <= end; i += step) allowed.add(i)
      continue
    }

    // 范围：1-5
    const rangeMatch = part.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end; i++) allowed.add(i)
      continue
    }

    // 单个数字
    const num = parseInt(part, 10)
    if (!isNaN(num)) allowed.add(num)
  }

  return (val) => allowed.has(val)
}

/**
 * 判断 cron 表达式是否合法（5 字段）
 */
function isValidCron(spec) {
  const fields = spec.trim().split(/\s+/)
  if (fields.length !== 5) return false
  // 简单校验每个字段格式
  const pattern = /^(\*|\d+(-\d+)?(\/\d+)?)(,(\d+(-\d+)?(\/\d+)?))*$|^\*\/\d+$/
  return fields.every(f => pattern.test(f))
}

/**
 * 判断当前时间是否匹配 cron 表达式
 */
function matchesCron(spec, now) {
  const fields = spec.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const matchers = [
    parseCronField(fields[0], 0, 59),   // 分
    parseCronField(fields[1], 0, 23),   // 时
    parseCronField(fields[2], 1, 31),   // 日
    parseCronField(fields[3], 1, 12),   // 月
    parseCronField(fields[4], 0, 6),    // 周（0=周日）
  ]

  const values = [
    now.getMinutes(),
    now.getHours(),
    now.getDate(),
    now.getMonth() + 1,
    now.getDay(),
  ]

  return matchers.every((match, i) => match(values[i]))
}

// --- 调度管理 ---

/**
 * 启动单个 job 的调度
 */
function scheduleJob(job, executor) {
  stopJob(job)

  const interval = parseInterval(job.spec)

  if (interval) {
    // 简单间隔模式
    job.timer = setInterval(() => executeWithGuard(job, executor), interval)
    console.log(`[cron] Job #${job.id} scheduled: every ${job.spec}`)
  } else {
    // cron 表达式模式：每分钟检查
    job.timer = setInterval(() => {
      const now = new Date()
      if (matchesCron(job.spec, now)) {
        executeWithGuard(job, executor)
      }
    }, 60 * 1000)
    console.log(`[cron] Job #${job.id} scheduled: cron "${job.spec}"`)
  }
}

/**
 * 停止单个 job 的调度
 */
function stopJob(job) {
  if (job.timer) {
    clearInterval(job.timer)
    job.timer = null
  }
}

/**
 * 带并发控制的执行
 */
async function executeWithGuard(job, executor) {
  if (job.running) {
    console.log(`[cron] Job #${job.id} still running, skip this tick`)
    return
  }

  job.running = true
  console.log(`[cron] Executing job #${job.id}: ${job.prompt.slice(0, 50)}`)
  try {
    await executor(job)
  } catch (err) {
    console.error(`[cron] Job #${job.id} error:`, err.message)
  } finally {
    job.running = false
  }
}

// --- 导出 API ---

/**
 * 启动时调用，读取持久化文件，恢复调度
 * @param {function} executor - async (job) => void
 */
function loadJobs(executor) {
  const saved = loadFromDisk()
  if (saved.length === 0) {
    console.log('[cron] No persisted jobs to restore')
    return
  }

  let maxId = 0
  for (const data of saved) {
    const job = {
      id: data.id,
      spec: data.spec,
      prompt: data.prompt,
      chatId: data.chatId,
      userId: data.userId,
      createdAt: data.createdAt,
      timer: null,
      running: false,
    }
    cronJobs.set(job.id, job)
    scheduleJob(job, executor)
    const numId = parseInt(job.id, 10)
    if (numId > maxId) maxId = numId
  }

  nextId = maxId + 1
  console.log(`[cron] Restored ${saved.length} jobs, next ID: ${nextId}`)
}

/**
 * 创建新任务
 * @param {object} opts - { spec, prompt, chatId, userId }
 * @param {function} executor - async (job) => void
 * @returns {{ ok: boolean, error?: string, job?: object }}
 */
function addJob({ spec, prompt, chatId, userId }, executor) {
  // 校验 spec
  const interval = parseInterval(spec)
  if (!interval && !isValidCron(spec)) {
    return { ok: false, error: `无法解析 "${spec}"。支持格式：5m, 30m, 1h 或标准 cron 表达式（如 "0 9 * * 1-5"）` }
  }

  const id = String(nextId++)
  const job = {
    id,
    spec,
    prompt,
    chatId,
    userId,
    createdAt: Date.now(),
    timer: null,
    running: false,
  }

  cronJobs.set(id, job)
  scheduleJob(job, executor)
  saveToDisk()

  return { ok: true, job }
}

/**
 * 删除任务
 */
function removeJob(id) {
  const job = cronJobs.get(id)
  if (!job) return false
  stopJob(job)
  cronJobs.delete(id)
  saveToDisk()
  return true
}

/**
 * 列出所有任务
 */
function listJobs() {
  return Array.from(cronJobs.values()).map(job => ({
    id: job.id,
    spec: job.spec,
    prompt: job.prompt,
    chatId: job.chatId,
    userId: job.userId,
    createdAt: job.createdAt,
    running: job.running,
  }))
}

/**
 * 获取单个任务
 */
function getJob(id) {
  const job = cronJobs.get(id)
  if (!job) return null
  return {
    id: job.id,
    spec: job.spec,
    prompt: job.prompt,
    chatId: job.chatId,
    userId: job.userId,
    createdAt: job.createdAt,
    running: job.running,
  }
}

module.exports = { loadJobs, addJob, removeJob, listJobs, getJob }
