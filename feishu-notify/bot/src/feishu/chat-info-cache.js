'use strict'

const { client } = require('./message-sender')

const TTL = 60 * 60 * 1000 // 1h
const cache = new Map() // chatId → { userCount, fetchedAt }

async function getUserCount(chatId) {
  if (!chatId) return null
  const cached = cache.get(chatId)
  if (cached && Date.now() - cached.fetchedAt < TTL) return cached.userCount
  try {
    const r = await client.im.v1.chat.get({ path: { chat_id: chatId } })
    const d = (r && r.data) || r
    const uc = parseInt(d && d.user_count, 10)
    if (!Number.isNaN(uc)) {
      cache.set(chatId, { userCount: uc, fetchedAt: Date.now() })
      return uc
    }
  } catch (err) {
    console.warn(`[chat-info] chat.get(${chatId}) 失败: ${err && err.message || err}`)
  }
  return null
}

// user_count 不含 bot 自己，单人群 = bot + 1 真人 ⇒ user_count === 1
// 取不到时返回 false（按多人群处理，触发 reply_in_thread，更安全）
async function isSoloGroup(chatId) {
  const uc = await getUserCount(chatId)
  return uc === 1
}

module.exports = { getUserCount, isSoloGroup }
