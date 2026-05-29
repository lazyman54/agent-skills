'use strict'

const { authenticate, setSecurityHeaders } = require('./auth-middleware')
const { handleSessions, handleStats, handleSessionMessages, handleDeleteSession, handleCronTrigger, handleCronList } = require('./api')
const { getPageHtml } = require('./page')

/**
 * 处理 /admin* 请求
 * @returns {boolean} 是否已处理
 */
function handleAdminRequest(req, res) {
  const url = req.url.split('?')[0]

  if (!url.startsWith('/admin')) return false

  setSecurityHeaders(res)

  // GET /admin — 管理后台页面（公开）
  if (req.method === 'GET' && (url === '/admin' || url === '/admin/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(getPageHtml())
    return true
  }

  // /admin/api/* — 需要认证
  if (url.startsWith('/admin/api/')) {
    if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return true
    }

    const authError = authenticate(req)
    if (authError) {
      res.writeHead(authError.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(authError.body))
      return true
    }

    if (url === '/admin/api/cron/jobs') {
      handleCronList(req, res)
      return true
    }

    if (url === '/admin/api/cron/trigger' && req.method === 'POST') {
      handleCronTrigger(req, res)
      return true
    }

    if (url === '/admin/api/sessions' && req.method === 'DELETE') {
      handleDeleteSession(req, res)
      return true
    }

    if (url === '/admin/api/sessions') {
      handleSessions(req, res)
      return true
    }

    if (url === '/admin/api/stats') {
      handleStats(req, res)
      return true
    }

    if (url === '/admin/api/messages') {
      handleSessionMessages(req, res)
      return true
    }
  }

  // 未匹配的 /admin/* 路径
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
  return true
}

module.exports = { handleAdminRequest }
