'use strict'

const fs = require('fs')
const path = require('path')

const CACHE_FILE = path.resolve(__dirname, '../../data/user-cache.json')

let cache = {}
let dirty = false

// 启动时加载
try {
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  }
} catch (err) {
  console.error('[user-cache] Load failed:', err.message)
  cache = {}
}

/**
 * 学习用户映射（userId → openId）
 * @param {string} userId - 用户英文名 ID（如 "lionli"）
 * @param {string} openId - 飞书 open_id（如 "ou_xxx"）
 */
function learn(userId, openId) {
  if (!userId || !openId) return
  if (cache[userId] === openId) return
  cache[userId] = openId
  dirty = true
}

/**
 * 通过用户名获取 open_id
 * @param {string} name - 用户名
 * @returns {string|null}
 */
function getOpenId(name) {
  return cache[name] || null
}

/**
 * 获取全部映射（用于传递给 feishu-project archive.js）
 * @returns {object}
 */
function getAll() {
  return { ...cache }
}

// 定期持久化（每 30 秒检查一次）
setInterval(() => {
  if (!dirty) return
  dirty = false
  try {
    const dir = path.dirname(CACHE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
  } catch (err) {
    console.error('[user-cache] Save failed:', err.message)
  }
}, 30000)

module.exports = { learn, getOpenId, getAll, CACHE_FILE }
