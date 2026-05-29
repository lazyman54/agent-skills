'use strict'

const crypto = require('crypto')
const config = require('../../config.json')

const ADMIN_TOKEN = config.admin?.token || ''
const MAX_FAILURES = 10
const WINDOW_MS = 5 * 60 * 1000 // 5 minutes

// IP -> { count, firstFailAt }
const failureMap = new Map()

// 定期清理过期记录
setInterval(() => {
  const now = Date.now()
  for (const [ip, record] of failureMap) {
    if (now - record.firstFailAt > WINDOW_MS) {
      failureMap.delete(ip)
    }
  }
}, 60000)

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'
}

/**
 * 检查 IP 是否被限流
 */
function isRateLimited(ip) {
  const record = failureMap.get(ip)
  if (!record) return false
  if (Date.now() - record.firstFailAt > WINDOW_MS) {
    failureMap.delete(ip)
    return false
  }
  return record.count >= MAX_FAILURES
}

/**
 * 记录一次认证失败
 */
function recordFailure(ip) {
  const record = failureMap.get(ip)
  if (!record || Date.now() - record.firstFailAt > WINDOW_MS) {
    failureMap.set(ip, { count: 1, firstFailAt: Date.now() })
  } else {
    record.count++
  }
}

/**
 * 验证 Bearer token（timing-safe）
 */
function verifyToken(token) {
  if (!ADMIN_TOKEN || !token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(ADMIN_TOKEN)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * 认证请求，返回 null 表示通过，否则返回 { status, body }
 */
function authenticate(req) {
  const ip = getClientIp(req)

  if (isRateLimited(ip)) {
    return { status: 429, body: { error: 'Too many failed attempts. Try again later.' } }
  }

  const authHeader = req.headers['authorization'] || ''
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  const token = match ? match[1] : ''

  if (!verifyToken(token)) {
    recordFailure(ip)
    return { status: 401, body: { error: 'Unauthorized' } }
  }

  return null
}

/**
 * 设置安全响应头
 */
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;")
}

module.exports = { authenticate, setSecurityHeaders }
