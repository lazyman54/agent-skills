'use strict'

const config = require('../../config.json')

// 待回答问题: sessionKey → { questions, sessionId, chatId, userId, chatType, messageId, model, reactionId, msgIndex, timestamp }
const pendingQuestions = new Map()
// 与 session.ttl 对齐：MR CR 周期可能长达数天，按钮有效期应覆盖同样时长
const QUESTION_TTL = (config.session && config.session.ttl) || 7 * 24 * 3600 * 1000

function setPendingQuestion(sessionKey, data) {
  pendingQuestions.set(sessionKey, { ...data, timestamp: Date.now() })
  console.log(`[interaction] 注册待回答问题: ${sessionKey}`)
}

function hasPendingQuestion(sessionKey) {
  const q = pendingQuestions.get(sessionKey)
  if (!q) return false
  if (Date.now() - q.timestamp > QUESTION_TTL) {
    pendingQuestions.delete(sessionKey)
    return false
  }
  return true
}

function consumePendingQuestion(sessionKey) {
  const q = pendingQuestions.get(sessionKey)
  if (!q) return null
  pendingQuestions.delete(sessionKey)
  if (Date.now() - q.timestamp > QUESTION_TTL) {
    console.log(`[interaction] 待回答问题已过期: ${sessionKey}`)
    return null
  }
  console.log(`[interaction] 消费待回答问题: ${sessionKey}`)
  return q
}

// 每分钟清理过期问题
setInterval(() => {
  const now = Date.now()
  for (const [key, q] of pendingQuestions) {
    if (now - q.timestamp > QUESTION_TTL) {
      console.log(`[interaction] 清理过期问题: ${key}`)
      pendingQuestions.delete(key)
    }
  }
}, 60000)

function getPendingQuestion(sessionKey) {
  const q = pendingQuestions.get(sessionKey)
  if (!q) return null
  if (Date.now() - q.timestamp > QUESTION_TTL) {
    pendingQuestions.delete(sessionKey)
    return null
  }
  return q
}

function answerQuestion(sessionKey, questionIndex, optionIndex) {
  const q = getPendingQuestion(sessionKey)
  if (!q) return null
  if (!q.answers) q.answers = {}
  q.answers[questionIndex] = optionIndex

  const totalQuestions = (q.questions || []).length
  const answeredCount = Object.keys(q.answers).length

  return { allAnswered: answeredCount >= totalQuestions, answers: q.answers, pending: q }
}

module.exports = { setPendingQuestion, hasPendingQuestion, consumePendingQuestion, getPendingQuestion, answerQuestion, QUESTION_TTL }
