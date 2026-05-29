'use strict'

const lark = require('@larksuiteoapi/node-sdk')
const config = require('../../config.json')
const userCache = require('./user-cache')
const { QUESTION_TTL } = require('./interaction-manager')

function formatTtl(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  const days = Math.round(hours / 24)
  return `${days} 天`
}

// --- SDK Client（全局单例，自动管理 token）---

const client = new lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  domain: lark.Domain.Feishu,
})

// --- bot 自身 open_id 缓存（用于群聊 @机器人 判断）---

let botOpenId = ''

async function fetchBotOpenId() {
  try {
    const resp = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
    const id = resp?.bot?.open_id || ''
    if (id) {
      botOpenId = id
      console.log(`[bot] open_id 已缓存: ${id}`)
    } else {
      console.warn('[bot] /bot/v3/info 返回中未找到 open_id')
    }
    return id
  } catch (err) {
    console.warn(`[bot] 拉取 bot info 失败（不影响启动）: ${err?.message || err}`)
    return ''
  }
}

function getBotOpenId() {
  return botOpenId
}

// --- 消息发送 ---

async function replyMessage(messageId, content, msgType = 'text', { replyInThread = false } = {}) {
  return client.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      content: typeof content === 'string' ? content : JSON.stringify(content),
      msg_type: msgType,
      ...(replyInThread ? { reply_in_thread: true } : {}),
    },
  })
}

async function sendMessage(receiveIdType, receiveId, content, msgType = 'text') {
  return client.im.v1.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      msg_type: msgType,
    },
  })
}

async function updateMessage(messageId, content, msgType = 'text') {
  return client.im.v1.message.update({
    path: { message_id: messageId },
    data: {
      content: typeof content === 'string' ? content : JSON.stringify(content),
      msg_type: msgType,
    },
  })
}

async function patchCard(messageId, cardJson) {
  return client.im.v1.message.patch({
    path: { message_id: messageId },
    data: {
      content: typeof cardJson === 'string' ? cardJson : JSON.stringify(cardJson),
    },
  })
}

// --- 附件发送（图片/文件）---

const fs = require('fs')
const path = require('path')

/**
 * 发送文件到群聊或私聊。用于 Claude 附件协议 [[ATTACH_FILE:path]] 的服务端落地。
 * 传入 replyToMessageId 时走 reply 路径，附件会自动落到原消息所在话题，与文本回复一致。
 * @param {string} chatId - 群/聊 id（open_id / chat_id），无 replyToMessageId 时作为 receive_id
 * @param {string} filePath - 本地绝对路径
 * @param {object} [options]
 * @param {'chat_id'|'open_id'} [options.receiveIdType='chat_id']
 * @param {string|null} [options.replyToMessageId=null] - 存在时改用 im.v1.message.reply
 * @param {boolean} [options.replyInThread=false] - 透传给 replyMessage（首次创建话题用）
 */
async function sendFile(chatId, filePath, options = {}) {
  const { receiveIdType = 'chat_id', replyToMessageId = null, replyInThread = false } = options
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  const uploadRes = await client.im.v1.file.create({
    data: {
      file_type: 'stream',
      file_name: path.basename(filePath),
      file: fs.createReadStream(filePath),
      duration: undefined,
    },
  })
  const fileKey = uploadRes && (uploadRes.file_key || (uploadRes.data && uploadRes.data.file_key))
  if (!fileKey) throw new Error(`Upload failed, no file_key: ${JSON.stringify(uploadRes).slice(0, 200)}`)
  const content = JSON.stringify({ file_key: fileKey })
  if (replyToMessageId) {
    return replyMessage(replyToMessageId, content, 'file', { replyInThread })
  }
  return sendMessage(receiveIdType, chatId, content, 'file')
}

/**
 * 发送图片到群聊或私聊。replyToMessageId 见 sendFile 注释。
 */
async function sendImage(chatId, imagePath, options = {}) {
  const { receiveIdType = 'chat_id', replyToMessageId = null, replyInThread = false } = options
  if (!fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`)
  const uploadRes = await client.im.v1.image.create({
    data: {
      image_type: 'message',
      image: fs.createReadStream(imagePath),
    },
  })
  const imageKey = uploadRes && (uploadRes.image_key || (uploadRes.data && uploadRes.data.image_key))
  if (!imageKey) throw new Error(`Upload failed, no image_key: ${JSON.stringify(uploadRes).slice(0, 200)}`)
  const content = JSON.stringify({ image_key: imageKey })
  if (replyToMessageId) {
    return replyMessage(replyToMessageId, content, 'image', { replyInThread })
  }
  return sendMessage(receiveIdType, chatId, content, 'image')
}

// --- 消息读取 ---

async function getMessage(messageId) {
  return client.im.v1.message.get({
    path: { message_id: messageId },
  })
}

// --- 表情反应 ---

async function addReaction(messageId, emojiType) {
  return client.im.v1.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } },
  })
}

async function removeReaction(messageId, reactionId) {
  return client.im.v1.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  })
}

// --- 处理状态管理 ---

async function addProcessingReaction(messageId) {
  const res = await addReaction(messageId, 'OnIt')
  return res?.data?.reaction_id || null
}

async function replaceReaction(messageId, oldReactionId, newEmoji) {
  if (oldReactionId) {
    await removeReaction(messageId, oldReactionId).catch(() => {})
  }
  return addReaction(messageId, newEmoji)
}

// --- 辅助 ---

/**
 * 清洗文本内容，移除飞书 API 不接受的字符
 * - 移除 null bytes 和大部分 C0/C1 控制字符（保留 \n \r \t）
 * - 移除零宽字符（ZWSP, ZWNJ, ZWJ, BOM 等）
 * - 确保文本不为空
 */
function sanitizeText(text) {
  if (!text) return '(空内容)'
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g, '')
    // 剥离 URL 周围的 Markdown 加粗/斜体标记，避免飞书自动链接时把 ** 当作 URL 的一部分
    .replace(/\*{1,2}(https?:\/\/[^\s*]+)\*{1,2}/g, '$1')
    || '(空内容)'
}

/**
 * 将文本中的 @name 替换为飞书 <at> 标签
 * 仅替换 user-cache 中已知的用户
 */
function applyMentions(text) {
  return text.replace(/@([a-zA-Z]\w{1,})/g, (match, name) => {
    const openId = userCache.getOpenId(name)
    if (openId) return `<at user_id="${openId}">${name}</at>`
    return match
  })
}

function textContent(text) {
  return JSON.stringify({ text: applyMentions(sanitizeText(text)) })
}

// --- AskUserQuestion 飞书卡片 ---

const QUESTION_NUM_EMOJIS = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3']

/**
 * 将 AskUserQuestion 的 questions 数组构建为飞书交互卡片 JSON
 * @param {Array} questions - AskUserQuestion 的 questions 数组
 * @param {string} [sessionKey] - 会话 key，传入时生成可点击按钮
 */
function buildQuestionCard(questions, sessionKey) {
  const elements = []

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    if (qi > 0) elements.push({ tag: 'hr' })

    // 问题文本
    let md = `**${q.header || '问题'}**\n\n${q.question}\n`
    elements.push({ tag: 'markdown', content: md })

    const opts = q.options || []

    // 选项描述（帮助用户决策）
    if (opts.some(o => o.description)) {
      let descMd = ''
      opts.forEach((opt, i) => {
        const num = QUESTION_NUM_EMOJIS[i] || `${i + 1}.`
        descMd += `${num} **${opt.label}** — ${opt.description || ''}\n`
      })
      elements.push({ tag: 'markdown', content: descMd })
    }

    // 按钮行（单选且有 sessionKey 时生成可点击按钮）
    if (!q.multiSelect && sessionKey) {
      const buttons = opts.map((opt, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.label },
        type: i === 0 ? 'primary' : 'default',
        value: { sk: sessionKey, qi, idx: i },
      }))
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'transparent',
        horizontal_spacing: '8px',
        columns: buttons.map(btn => ({
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [btn],
        })),
      })
    } else if (!q.multiSelect) {
      // 无 sessionKey 时仅显示编号列表（纯文本模式）
      let listMd = ''
      opts.forEach((opt, i) => {
        const num = QUESTION_NUM_EMOJIS[i] || `${i + 1}.`
        listMd += `${num} **${opt.label}**\n`
      })
      if (!opts.some(o => o.description)) {
        elements.push({ tag: 'markdown', content: listMd })
      }
    }

    if (q.multiSelect) {
      elements.push({ tag: 'markdown', content: '_（多选：请直接回复编号，用逗号分隔，如 `1,3`）_' })
    }
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: sessionKey
      ? `点击按钮选择，或直接回复文字自定义回答（${formatTtl(QUESTION_TTL)}内有效）`
      : `请回复选项编号选择，或直接输入自定义回答（${formatTtl(QUESTION_TTL)}内有效）`,
    text_size: 'notation',
  })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Claude 需要你的确认' },
      template: 'blue',
    },
    body: { elements },
  }
}

/**
 * 构建按钮点击后的更新卡片（绿色，显示已选择项）
 */
function buildAnsweredCard(questions, questionIndex, selectedIndex) {
  const q = questions[questionIndex] || questions[0] || {}
  const opt = (q.options || [])[selectedIndex]
  const label = opt ? opt.label : `选项 ${selectedIndex + 1}`

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Claude 确认 \u2713' },
      template: 'green',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `**${q.header || '问题'}**\n\n${q.question}` },
        { tag: 'markdown', content: `**已选择：** ${label}\n\n_处理中..._` },
      ],
    },
  }
}

/**
 * 多问题卡片：部分已答（已答显示结果，未答保留按钮）
 */
function buildPartialAnsweredCard(questions, answers, sessionKey) {
  const elements = []

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    if (qi > 0) elements.push({ tag: 'hr' })

    if (answers[qi] != null) {
      const a = answers[qi]
      const label = typeof a === 'number'
        ? ((q.options || [])[a]?.label || `选项 ${a + 1}`)
        : String(a)
      elements.push({ tag: 'markdown', content: `**${q.header || '问题'}**\n\n${q.question}` })
      elements.push({ tag: 'markdown', content: `**已选择：** ${label}` })
    } else {
      let md = `**${q.header || '问题'}**\n\n${q.question}\n`
      elements.push({ tag: 'markdown', content: md })

      const opts = q.options || []
      if (opts.some(o => o.description)) {
        let descMd = ''
        opts.forEach((opt, i) => {
          const num = QUESTION_NUM_EMOJIS[i] || `${i + 1}.`
          descMd += `${num} **${opt.label}** — ${opt.description || ''}\n`
        })
        elements.push({ tag: 'markdown', content: descMd })
      }

      if (!q.multiSelect && sessionKey) {
        const buttons = opts.map((opt, i) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: opt.label },
          type: i === 0 ? 'primary' : 'default',
          value: { sk: sessionKey, qi, idx: i },
        }))
        elements.push({
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'transparent',
          horizontal_spacing: '8px',
          columns: buttons.map(btn => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [btn],
          })),
        })
      }

      if (q.multiSelect) {
        elements.push({ tag: 'markdown', content: '_（多选：请直接回复编号，用逗号分隔，如 `1,3`）_' })
      }
    }
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: `点击按钮选择，或直接回复文字自定义回答（${formatTtl(QUESTION_TTL)}内有效）`,
    text_size: 'notation',
  })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Claude 需要你的确认' },
      template: 'blue',
    },
    body: { elements },
  }
}

/**
 * 多问题卡片：全部已答（绿色最终状态）
 */
function buildAllAnsweredCard(questions, answers) {
  const elements = []
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    const a = answers[qi]
    const label = typeof a === 'number'
      ? ((q.options || [])[a]?.label || `选项 ${a + 1}`)
      : String(a)
    if (qi > 0) elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `**${q.header || '问题'}**\n${q.question}` })
    elements.push({ tag: 'markdown', content: `**已选择：** ${label}` })
  }
  elements.push({ tag: 'markdown', content: '_处理中..._' })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: 'Claude 确认 \u2713' },
      template: 'green',
    },
    body: { elements },
  }
}

module.exports = {
  client,
  fetchBotOpenId,
  getBotOpenId,
  getMessage,
  replyMessage,
  sendMessage,
  updateMessage,
  patchCard,
  addReaction,
  removeReaction,
  addProcessingReaction,
  replaceReaction,
  textContent,
  sanitizeText,
  applyMentions,
  buildQuestionCard,
  buildAnsweredCard,
  buildPartialAnsweredCard,
  buildAllAnsweredCard,
  sendFile,
  sendImage,
}
