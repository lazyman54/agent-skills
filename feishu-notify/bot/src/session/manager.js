'use strict'

const fs = require('fs')
const path = require('path')
const config = require('../../config.json')

const resourceDownloader = require('../feishu/resource-downloader')
const sessionResources = require('../session-resources')

const TTL = config.session.ttl || 604800000 // 默认 7d

function isDmSession(key) { return key.startsWith('dm:') }
const PERSIST_FILE = path.join(__dirname, '../../data/sessions.json')
const SAVE_INTERVAL = 30000 // 30 秒保存一次

// sessions: Map<key, {sessionId, model, usage, createdAt, lastActiveAt}>
const sessions = new Map()
let dirty = false // 有变更时标记，避免无意义写盘

function markDirty() { dirty = true }

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return
    const raw = fs.readFileSync(PERSIST_FILE, 'utf8')
    const entries = JSON.parse(raw)
    const now = Date.now()
    for (const [key, s] of entries) {
      // 私聊不过期，其他按 TTL 过期
      if (!isDmSession(key) && now - s.lastActiveAt > TTL) {
        resourceDownloader.cleanupSession(key)
        sessionResources.cleanupSession(key)
        continue
      }
      // 清理重启前未完成的 processing 状态（所有残留，不只最后一条）
      if (s.messages) {
        for (const m of s.messages) {
          if (m.processing) {
            m.processing = false
            m.text = m.text || '[进程重启，处理中断]'
          }
        }
      }
      sessions.set(key, s)
    }
    console.log(`[session] loaded ${sessions.size} sessions from disk`)
  } catch (e) {
    console.error('[session] failed to load sessions from disk:', e.message)
  }
}

function saveToDisk() {
  if (!dirty) return
  dirty = false
  try {
    const dir = path.dirname(PERSIST_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const entries = Array.from(sessions.entries())
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(entries), 'utf8')
  } catch (e) {
    console.error('[session] failed to save sessions to disk:', e.message)
  }
}

// --- 显式初始化（由 server.js 调用，避免 require 时自动启动定时器）---
// 注：SIGTERM/SIGINT 由 server.js 统一处理（需协调活跃任务保存 + 会话保存）

function initSessionManager() {
  loadFromDisk()
  setInterval(saveToDisk, SAVE_INTERVAL)
}

/**
 * 生成会话 key：
 * - 私聊：dm:userId
 * - 单人群（仅 bot+1 用户）：chat:gid:userId 永久绑定，无视 rootId（用户引用 bot 消息也不分裂会话）
 * - 多人群话题（rootId 非空）：thread:rootId（跨用户引用 bot 自动共享会话）
 * - 多人群首条（无 rootId）：thread:messageId 预创话题（配合 reply_in_thread）
 */
function makeKey(chatType, chatId, rootId, userId, messageId, opts = {}) {
  if (chatType === 'p2p') return `dm:${userId}`
  if (opts.isSoloGroup && chatId) return `chat:${chatId}:${userId}`
  if (rootId) return `thread:${rootId}`
  if (chatId && messageId) return `thread:${messageId}`
  if (chatId) return `chat:${chatId}:${userId}`
  return `dm:${userId}`
}

function getSession(key) {
  const session = sessions.get(key)
  if (!session) return null
  // 私聊不过期
  if (!isDmSession(key) && Date.now() - session.lastActiveAt > TTL) {
    resourceDownloader.cleanupSession(key)
    sessionResources.cleanupSession(key)
    sessions.delete(key)
    return null
  }
  session.lastActiveAt = Date.now()
  return session
}

function createSession(key, model) {
  const session = {
    sessionId: null,
    model: model || config.claude.model || 'sonnet',
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  }
  sessions.set(key, session)
  markDirty()
  return session
}

function getOrCreateSession(key, model) {
  return getSession(key) || createSession(key, model)
}

function resetSession(key) {
  resourceDownloader.cleanupSession(key)
  sessionResources.cleanupSession(key)
  sessions.delete(key)
  markDirty()
}

function updateSession(key, updates) {
  const session = sessions.get(key)
  if (!session) return
  if (updates.sessionId) session.sessionId = updates.sessionId
  if (updates.model) session.model = updates.model
  // 上下文占用只用 lastTurnUsage（最后一次 API 调用），对齐 Claude Code /context
  // result.usage 是累计值、语义不同，不做 fallback
  if (updates.lastTurnUsage) {
    const u = updates.lastTurnUsage
    const contextTokens =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0)
    session.usage.contextTokens = contextTokens
    session.usage.inputTokens = contextTokens
  }
  // outputTokens 用累计 usage 累加，保持累计语义
  if (updates.usage) {
    session.usage.outputTokens += updates.usage.output_tokens || 0
  }
  if (updates.costUsd) {
    session.costUsd += updates.costUsd
  }
  session.lastActiveAt = Date.now()
  markDirty()
}

function addMessage(key, role, text, steps) {
  const session = sessions.get(key)
  if (!session) return
  if (!session.messages) session.messages = []
  const msg = { role, text, ts: Date.now() }
  if (steps && steps.length > 0) {
    msg.steps = steps
  }
  session.messages.push(msg)
  // 最多保留最近 50 轮消息，防止内存膨胀
  if (session.messages.length > 100) {
    session.messages = session.messages.slice(-100)
  }
  markDirty()
}

/**
 * 开始处理：记录用户消息 + 创建一条 processing 中的 assistant 占位消息
 * @returns {number} assistant 占位消息的数组索引（msgIndex），用于后续 appendStep/finishProcessing
 */
function startProcessing(key, userText) {
  const session = sessions.get(key)
  if (!session) return -1
  if (!session.messages) session.messages = []
  session.messages.push({ role: 'user', text: userText, ts: Date.now() })
  session.messages.push({ role: 'assistant', text: '', ts: Date.now(), steps: [], processing: true })
  session.lastActiveAt = Date.now()
  markDirty()
  return session.messages.length - 1
}

/**
 * 实时追加一个 step 到指定 processing 的 assistant 消息
 * @param {number} [msgIndex] - 目标消息索引，不传则操作最后一条（向后兼容）
 */
function appendStep(key, step, msgIndex) {
  const session = sessions.get(key)
  if (!session || !session.messages) return
  const msg = (msgIndex != null) ? session.messages[msgIndex] : session.messages[session.messages.length - 1]
  if (!msg || !msg.processing) return
  if (!msg.steps) msg.steps = []
  if (msg.steps.length < 1000) {
    msg.steps.push(step)
  }
}

/**
 * 完成处理：填充 assistant 消息的最终内容，移除 processing 标记
 * @param {number} [msgIndex] - 目标消息索引，不传则操作最后一条（向后兼容）
 */
function finishProcessing(key, resultText, msgIndex) {
  const session = sessions.get(key)
  if (!session || !session.messages) return
  const msg = (msgIndex != null) ? session.messages[msgIndex] : session.messages[session.messages.length - 1]
  if (!msg || !msg.processing) return
  msg.text = resultText
  msg.processing = false
  msg.ts = Date.now()
  // 清理：仅在没有任何 processing 中的消息时才 slice，避免 slice 使其他并发请求的 msgIndex 失效
  if (session.messages.length > 100 && !session.messages.some(m => m.processing)) {
    session.messages = session.messages.slice(-100)
  }
  markDirty()
}

/**
 * 处理失败/取消：标记 processing 消息为已取消或移除占位
 * @param {number} [msgIndex] - 目标消息索引，不传则操作最后一条（向后兼容）
 */
function cancelProcessing(key, msgIndex) {
  const session = sessions.get(key)
  if (!session || !session.messages) return
  if (msgIndex != null) {
    const msg = session.messages[msgIndex]
    if (msg && msg.processing) {
      msg.processing = false
      msg.text = '[已取消]'
      msg.ts = Date.now()
      markDirty()
    }
  } else {
    // 向后兼容：无索引时 pop 最后一条
    const last = session.messages[session.messages.length - 1]
    if (last && last.processing) {
      session.messages.pop()
      markDirty()
    }
  }
}

/**
 * 直接更新指定消息的文本（不检查 processing 状态）
 */
function updateMessageText(key, msgIndex, text) {
  const session = sessions.get(key)
  if (!session || !session.messages) return
  const msg = session.messages[msgIndex]
  if (!msg) return
  msg.text = text
  msg.ts = Date.now()
  markDirty()
}

function getSessionStats() {
  return {
    activeSessions: sessions.size,
    sessions: Array.from(sessions.entries()).map(([key, s]) => ({
      key,
      model: s.model,
      usage: s.usage,
      costUsd: s.costUsd,
      messageCount: (s.messages || []).length,
      processing: (s.messages || []).some(m => m.processing),
      age: Math.round((Date.now() - s.createdAt) / 60000) + 'min',
    })),
  }
}

function getSessionMessages(key) {
  const session = sessions.get(key)
  if (!session) return null
  return session.messages || []
}

// 定期清理过期 session
setInterval(() => {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (!isDmSession(key) && now - session.lastActiveAt > TTL) {
      resourceDownloader.cleanupSession(key)
      sessionResources.cleanupSession(key)
      sessions.delete(key)
      markDirty()
    }
  }
}, 600000) // 每 10 分钟清理

module.exports = {
  initSessionManager,
  saveToDisk,
  makeKey,
  getSession,
  createSession,
  getOrCreateSession,
  resetSession,
  updateSession,
  addMessage,
  startProcessing,
  appendStep,
  finishProcessing,
  cancelProcessing,
  updateMessageText,
  getSessionStats,
  getSessionMessages,
}
