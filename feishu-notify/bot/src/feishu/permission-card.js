'use strict'

const fs = require('fs')
const path = require('path')
const messageSender = require('./message-sender')

const CARD_META_DIR = '/tmp/claude_perm_cards'

// token -> { toolName, command, project, messageId? }（内存；重启后从磁盘恢复）
const pendingPermissions = new Map()

function cardMetaPath(token) {
  return path.join(CARD_META_DIR, `${token}.json`)
}

function saveCardMeta(token, payload) {
  pendingPermissions.set(token, payload)
  fs.mkdirSync(CARD_META_DIR, { recursive: true })
  fs.writeFileSync(cardMetaPath(token), JSON.stringify(payload), 'utf8')
}

function loadCardMeta(token) {
  const inMem = pendingPermissions.get(token)
  if (inMem) return inMem
  try {
    const raw = fs.readFileSync(cardMetaPath(token), 'utf8')
    const data = JSON.parse(raw)
    pendingPermissions.set(token, data)
    return data
  } catch {
    return null
  }
}

function removeCardMeta(token) {
  pendingPermissions.delete(token)
  try {
    fs.unlinkSync(cardMetaPath(token))
  } catch {
    /* ignore */
  }
}

const SOURCE_LABELS = {
  feishu: '飞书',
  terminal: '终端 feishu-approve',
  claude_terminal: 'Claude Code 终端',
  cursor_terminal: 'Cursor 终端',
}

function buildPermissionCard(token, { toolName, command, project }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { content: '⚠️ 需要你的决定', tag: 'plain_text' },
      template: 'yellow',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [`**工具**: ${toolName}`, `**项目**: ${project}`, '```', command, '```'].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'transparent',
          horizontal_spacing: '8px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 批准' },
                type: 'primary',
                value: { permToken: token, action: 'approve' },
              }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: '❌ 拒绝' },
                type: 'danger',
                value: { permToken: token, action: 'deny' },
              }],
            },
          ],
        },
      ],
    },
  }
}

function buildDecidedCard(decision, { toolName, command, project, source }) {
  const approved = decision === 'approve'
  const lines = [`**工具**: ${toolName}`, `**项目**: ${project}`]
  if (source && source !== 'feishu') {
    lines.push(`**处理**: ${SOURCE_LABELS[source] || source}`)
  }
  lines.push('```', command, '```')
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { content: approved ? '✅ 已批准' : '❌ 已拒绝', tag: 'plain_text' },
      template: approved ? 'green' : 'red',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: lines.join('\n'),
        },
      ],
    },
  }
}

async function sendPermissionCard(receiveIdType, receiveId, token, payload) {
  const card = buildPermissionCard(token, payload)
  const res = await messageSender.sendMessage(receiveIdType, receiveId, JSON.stringify(card), 'interactive')
  const messageId = res?.data?.message_id || ''
  const meta = { ...payload, messageId }
  pendingPermissions.set(token, meta)
  saveCardMeta(token, meta)
  return { messageId }
}

function getPayload(token) {
  return loadCardMeta(token)
}

function clearPayload(token) {
  removeCardMeta(token)
}

function writeResult(token, decision) {
  const path = `/tmp/claude_perm_${token}`
  try {
    const fd = fs.openSync(path, 'wx', 0o600)
    fs.writeSync(fd, decision, 'utf8')
    fs.closeSync(fd)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

/**
 * 外部决策（终端 / hook）：更新飞书卡片；若尚未决策则写入结果文件供 hook 轮询。
 */
async function applyExternalDecision(token, decision, source = 'terminal') {
  const payload = loadCardMeta(token)
  if (!payload) {
    return { ok: false, reason: 'unknown_token' }
  }
  if (payload.type === 'ask_user') {
    return { ok: false, reason: 'ask_user_use_question_flow' }
  }

  writeResult(token, decision)

  const { messageId, ...cardPayload } = payload
  if (messageId) {
    await messageSender.patchCard(
      messageId,
      buildDecidedCard(decision, { ...cardPayload, source }),
    )
  }

  clearPayload(token)
  return { ok: true, patched: Boolean(messageId) }
}

module.exports = {
  sendPermissionCard,
  buildDecidedCard,
  getPayload,
  clearPayload,
  writeResult,
  applyExternalDecision,
  loadCardMeta,
  saveCardMeta,
  removeCardMeta,
  CARD_META_DIR,
}
