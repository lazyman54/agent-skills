'use strict'

const { getSessionStats, getSessionMessages, resetSession } = require('../session/manager')
const cronManager = require('../session/cron')

/**
 * 脱敏会话 key 中的 userId
 * thread:om_xxx → thread:om_***
 * chat:oc_xxx:ou_yyy → chat:oc_***:ou_***
 * dm:ou_xxx → dm:ou_***
 */
function maskKey(key) {
  return key.replace(/(:|\b)(om_|oc_|ou_|on_)([a-zA-Z0-9]+)/g, (_, prefix, type, id) => {
    const visible = id.slice(0, 4)
    return `${prefix}${type}${visible}***`
  })
}

/**
 * GET /admin/api/sessions
 */
function handleSessions(req, res) {
  const stats = getSessionStats()
  const masked = {
    activeSessions: stats.activeSessions,
    sessions: stats.sessions.map((s) => ({
      ...s,
      rawKey: s.key,
    })),
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(masked))
}

/**
 * GET /admin/api/stats
 */
function handleStats(req, res) {
  const stats = getSessionStats()
  let totalMessages = 0

  for (const s of stats.sessions) {
    totalMessages += s.messageCount || 0
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    activeSessions: stats.activeSessions,
    totalMessages,
  }))
}

/**
 * GET /admin/api/sessions/:key/messages
 * key 通过 query param 传递: ?key=xxx
 */
function handleSessionMessages(req, res) {
  const urlObj = new URL(req.url, 'http://localhost')
  const key = urlObj.searchParams.get('key')

  if (!key) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing key parameter' }))
    return
  }

  const messages = getSessionMessages(key)
  if (messages === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session not found' }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ messages }))
}

/**
 * DELETE /admin/api/sessions?key=xxx
 */
function handleDeleteSession(req, res) {
  const urlObj = new URL(req.url, 'http://localhost')
  const key = urlObj.searchParams.get('key')

  if (!key) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing key parameter' }))
    return
  }

  const messages = getSessionMessages(key)
  if (messages === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session not found' }))
    return
  }

  resetSession(key)
  console.log(`[admin] 手动清除会话: ${key}`)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

/**
 * POST /admin/api/cron/trigger?id=xxx
 */
function handleCronTrigger(req, res) {
  const urlObj = new URL(req.url, 'http://localhost')
  const id = urlObj.searchParams.get('id')

  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing id parameter' }))
    return
  }

  const job = cronManager.getJob(id)
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Job #${id} not found` }))
    return
  }

  // 异步执行，立即返回
  const { executeCronJob } = require('../feishu/webhook-handler')
  executeCronJob(job).catch(err => {
    console.error(`[admin] Manual trigger job #${id} error:`, err.message)
  })

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, message: `Job #${id} triggered` }))
}

/**
 * GET /admin/api/cron/jobs
 */
function handleCronList(req, res) {
  const jobs = cronManager.listJobs()
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jobs }))
}

module.exports = { handleSessions, handleStats, handleSessionMessages, handleDeleteSession, handleCronTrigger, handleCronList }
