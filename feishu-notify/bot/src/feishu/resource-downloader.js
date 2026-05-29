'use strict'

const fs = require('fs')
const path = require('path')
const { client } = require('./message-sender')

const TMP_DIR = path.join(__dirname, '../../data/tmp')
const SESSION_MARKERS_DIR = path.join(TMP_DIR, '.sessions')
const PERSIST_FILE = path.join(__dirname, '../../data/resource-files.json')
const CLEANUP_INTERVAL = 30 * 60 * 1000 // 30 分钟
const SAVE_INTERVAL = 30000 // 30 秒保存一次

// 会话 → 文件路径集合
const sessionFiles = new Map()
let dirty = false

function markDirty() { dirty = true }

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true })
}

// --- 持久化 ---

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'))
    for (const [key, files] of raw) {
      const existing = files.filter(f => fs.existsSync(f))
      if (existing.length > 0) {
        sessionFiles.set(key, new Set(existing))
      }
    }
    console.log(`[resource] loaded ${sessionFiles.size} session file mappings from disk`)
  } catch (e) {
    console.error('[resource] failed to load from disk:', e.message)
  }
}

function saveToDisk() {
  if (!dirty) return
  dirty = false
  try {
    const dir = path.dirname(PERSIST_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const entries = Array.from(sessionFiles.entries()).map(([key, set]) => [key, Array.from(set)])
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(entries), 'utf8')
  } catch (e) {
    console.error('[resource] failed to save to disk:', e.message)
  }
}

function initResourceManager() {
  loadFromDisk()
  setInterval(saveToDisk, SAVE_INTERVAL)
}

/**
 * 从飞书下载消息中的资源文件（图片/文件）
 * @param {string} messageId - 消息 ID
 * @param {string} fileKey - 资源 key（image_key 或 file_key）
 * @param {'image'|'file'} type - 资源类型
 * @param {string} [fileName] - 原始文件名（仅 file 类型）
 * @returns {Promise<{filePath: string, originalName: string, type: string}|null>}
 */
async function downloadResource(messageId, fileKey, type, fileName) {
  ensureTmpDir()

  let ext = '.png'
  if (type === 'file' && fileName) {
    ext = path.extname(fileName) || '.bin'
  }
  const localName = `${messageId}_${fileKey}${ext}`
  const filePath = path.join(TMP_DIR, localName)

  // 已存在则直接返回（同一消息的重复处理）
  if (fs.existsSync(filePath)) {
    return { filePath, originalName: fileName || localName, type }
  }

  try {
    const res = await client.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    })
    await res.writeFile(filePath)
    console.log(`[resource] 下载成功: ${type} ${fileKey} → ${localName}`)
    return { filePath, originalName: fileName || localName, type }
  } catch (err) {
    console.error(`[resource] 下载失败: ${type} ${fileKey}:`, err.message)
    return null
  }
}

/**
 * 将文件注册到会话（用于会话结束时统一清理）
 */
function registerFile(sessionKey, filePath) {
  if (!sessionFiles.has(sessionKey)) {
    sessionFiles.set(sessionKey, new Set())
  }
  sessionFiles.get(sessionKey).add(filePath)
  markDirty()
}

/**
 * 获取会话中已注册的文件列表（仅返回仍存在的文件）
 */
function getSessionFiles(sessionKey) {
  const files = sessionFiles.get(sessionKey)
  if (!files || files.size === 0) return []
  const existing = []
  for (const filePath of files) {
    if (fs.existsSync(filePath)) {
      existing.push(filePath)
    }
  }
  return existing
}

/**
 * 清理指定会话的所有临时文件
 */
function cleanupSession(sessionKey) {
  // 同步清理外部 skill 留下的 registration marker（防孤儿）
  try {
    const marker = path.join(SESSION_MARKERS_DIR, `${sessionKey}.txt`)
    if (fs.existsSync(marker)) fs.unlinkSync(marker)
  } catch {}

  const files = sessionFiles.get(sessionKey)
  if (!files || files.size === 0) return
  for (const filePath of files) {
    try {
      fs.unlinkSync(filePath)
      console.log(`[resource] 清理会话文件: ${path.basename(filePath)}`)
    } catch {
      // 文件可能已被删除，忽略
    }
  }
  sessionFiles.delete(sessionKey)
  markDirty()
}

/**
 * 读取外部 skill（如 feishu-project archive.js 写的下载资源）写入的会话文件注册清单，
 * 把路径注册到 sessionFiles 后删除 marker。
 * 返回本次注册的文件数量。
 */
function ingestSessionRegistrations(sessionKey) {
  if (!sessionKey) return 0
  const marker = path.join(SESSION_MARKERS_DIR, `${sessionKey}.txt`)
  if (!fs.existsSync(marker)) return 0
  let registered = 0
  try {
    const raw = fs.readFileSync(marker, 'utf8')
    const paths = raw.split('\n').map(s => s.trim()).filter(Boolean)
    for (const p of paths) {
      if (fs.existsSync(p)) {
        registerFile(sessionKey, p)
        registered++
      }
    }
    fs.unlinkSync(marker)
    if (registered > 0) {
      console.log(`[resource] ingest ${registered} file(s) for session ${sessionKey}`)
    }
  } catch (err) {
    console.error(`[resource] ingestSessionRegistrations failed: ${err.message}`)
  }
  return registered
}

// 定时清理孤儿文件（不属于任何会话的文件）
function startPeriodicCleanup() {
  setInterval(() => {
    try {
      if (!fs.existsSync(TMP_DIR)) return
      // 收集所有会话追踪的文件路径
      const tracked = new Set()
      for (const files of sessionFiles.values()) {
        for (const f of files) tracked.add(f)
      }
      // 扫描 tmp 目录，删除未被任何会话追踪的孤儿文件
      for (const file of fs.readdirSync(TMP_DIR)) {
        // 跳过 skill registration marker 目录（由 ingestSessionRegistrations 消费）
        if (file === '.sessions') continue
        const filePath = path.join(TMP_DIR, file)
        try {
          if (fs.statSync(filePath).isDirectory()) continue
        } catch { continue }
        if (!tracked.has(filePath)) {
          fs.unlinkSync(filePath)
          console.log(`[resource] 清理孤儿文件: ${file}`)
        }
      }
    } catch (err) {
      console.error('[resource] 定时清理失败:', err.message)
    }
  }, CLEANUP_INTERVAL)
}

startPeriodicCleanup()

module.exports = { initResourceManager, saveToDisk, downloadResource, registerFile, getSessionFiles, cleanupSession, ingestSessionRegistrations }
