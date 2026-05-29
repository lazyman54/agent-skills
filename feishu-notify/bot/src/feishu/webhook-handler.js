'use strict'

const fs = require('fs')
const path = require('path')
const config = require('../../config.json')
const messageSender = require('./message-sender')
const resourceDownloader = require('./resource-downloader')
const chatInfoCache = require('./chat-info-cache')

/**
 * bot reply 出口的额外参数：群聊多人时塞 reply_in_thread:true，让回复落入话题；
 * 单人群和私聊不动。chat.get 失败时按多人群处理（更安全，避免污染原 chat 会话）。
 */
async function getReplyOpts(chatType, chatId) {
  if (chatType !== 'group' || !chatId) return undefined
  const solo = await chatInfoCache.isSoloGroup(chatId)
  return solo ? undefined : { replyInThread: true }
}

/**
 * 长消息硬截断兜底（Claude 应自主创建飞书文档分流超长内容）
 * 飞书文本消息上限约 30KB；我们在 3800 字处截断留提示
 */
function truncateForFeishu(text) {
  const MAX = 3800
  if (!text || text.length <= MAX) return text
  return text.slice(0, MAX) + '\n\n---\n⚠️ 内容过长已截断。请要求我创建飞书文档来承载完整内容。'
}

/**
 * 构造上下文使用量脚注（已用/上限/百分比/模型；超阈值时追加 /new 建议）
 * 所有回复路径共用此函数，保证 footer 一致
 */
function buildContextFooter(result) {
  // 只用 lastTurnUsage（最后一次 API 调用的 usage，对齐 Claude Code /context）
  // result.usage 是 stream-json type=result 的累计值，语义不同——不 fallback，宁可不显示
  const u = result?.lastTurnUsage || {}
  const contextTokens =
    (u.input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0)
  if (contextTokens <= 0) return ''
  const warnPercent = config.session.contextWarnPercent ?? 50
  const modelStr = result.model || config.claude?.model || ''
  const limitTokens = result.contextLimit || 200000
  const usedK = Math.round(contextTokens / 1000)
  const limitK = Math.round(limitTokens / 1000)
  const pct = Math.round((contextTokens / limitTokens) * 100)
  const modelShort = modelStr.replace(/^claude-/, '') || 'unknown'
  let footer = `\n\n📊 上下文 ${usedK}k / ${limitK}k (${pct}%) · ${modelShort}`
  if (pct >= warnPercent) {
    footer += `，建议发送 /new 清理上下文以获得更好的响应速度和质量`
  }
  return footer
}

/**
 * 解析 Claude reply 中的附件协议标记 [[ATTACH_FILE:path]] / [[ATTACH_IMAGE:path]]
 * 返回：{ text: 剥离后的文本, attachments: [{type, path}, ...] }
 * 路径白名单：只允许 /tmp/ 或 data/tmp/（含子目录）；非白名单路径静默丢弃
 */
function parseAttachments(text) {
  if (!text) return { text, attachments: [] }
  const attachments = []
  const re = /\[\[ATTACH_(FILE|IMAGE):([^\]\n]+)\]\]/g
  const stripped = text.replace(re, (_m, kind, p) => {
    const filePath = p.trim()
    if (!filePath.startsWith('/tmp/') && !filePath.includes('/data/tmp/')) {
      console.warn(`[attach] 拒绝非白名单路径: ${filePath}`)
      return ''
    }
    if (!fs.existsSync(filePath)) {
      console.warn(`[attach] 文件不存在: ${filePath}`)
      return ''
    }
    attachments.push({ type: kind.toLowerCase(), path: filePath })
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { text: stripped, attachments }
}
const claudeBridge = require('../claude/bridge')
const sessionManager = require('../session/manager')
const { handleCommand } = require('../session/commands')
const cronManager = require('../session/cron')
const { checkPermission } = require('../auth/permission')
const userCache = require('./user-cache')
const interactionManager = require('./interaction-manager')
const permissionCard = require('./permission-card')
const permissionQuestionCard = require('./permission-question-card')

/**
 * 检测并修复冗余/敷衍回复 — 从最近 text step 中选更完整的内容
 * @param {string} replyText - 原始回复文本
 * @param {Array} steps - 所有步骤
 * @param {string} logPrefix - 日志前缀（区分调用来源）
 * @returns {string} 修复后的回复文本
 */
function fixTruncatedReply(replyText, steps, logPrefix = '[msg]') {
  const textSteps = (steps || []).filter(s => s.type === 'text')
  const isTruncated = replyText && replyText.length < 200
    && textSteps.length >= 3
    && textSteps.slice(-3, -1).some(s => (s.fullText || s.content || '').length >= Math.max(replyText.length * 3, 200))
  if (!isTruncated) return replyText

  console.log(`${logPrefix} 检测到疑似冗余回复(${replyText.length}字, ${textSteps.length}步), 尝试从 text step 回退`)
  const candidates = textSteps.slice(-3)
  const best = candidates.reduce((a, b) =>
    (a.fullText || a.content || '').length >= (b.fullText || b.content || '').length ? a : b)
  const bestText = best.fullText || best.content || ''
  if (bestText.length > replyText.length) {
    console.log(`${logPrefix} 从最近 text step 回退到更完整的回复(${bestText.length}字)`)
    return bestText
  }
  return replyText
}

const markdownToCard = require('./markdown-to-card')

// 长 plan 阈值：plan mode 下 ExitPlanMode 的 plan 字段超过此长度时，
// 服务端 resume Claude 让其调 archive.js 建飞书文档，最终回复用摘要+链接
const PLAN_REPLY_LIMIT = 1000

/**
 * 长 plan 兜底：plan > 1000 字时 resume Claude，让它建飞书文档+发摘要链接
 * @param {object} result - bridge 返回的 result（含 exitPlan, sessionId, result）
 * @param {object} ctx - { session, sessionKey, msgIndex, messageId, chatId, chatType, openId, userId, logPrefix }
 * @returns {Promise<{aborted?:true}|object|null>}
 *   - null：未触发兜底或建文档失败/空结果（调用方继续直发原 plan）
 *   - { aborted: true }：archive resume 被用户撤回 abort（调用方应走撤回退出分支）
 *   - object（含 result/usage/costUsd/sessionId）：建文档成功，调用方用此替换 replyText
 */
async function maybeArchiveLongPlan(result, ctx) {
  if (!result.exitPlan || !result.result) return null
  const planLen = result.result.length
  if (planLen <= PLAN_REPLY_LIMIT) return null
  if (!result.sessionId) {
    console.warn(`${ctx.logPrefix} 长 plan(${planLen}字)但无 sessionId，无法 resume，降级直发`)
    return null
  }

  console.log(`${ctx.logPrefix} 长 plan(${planLen}字) → resume Claude 建飞书文档`)
  const archivePrompt = `你刚才用 ExitPlanMode 提交的 plan 长度 ${planLen} 字符,超过飞书消息约束(≤1000字)。请按以下步骤承载到飞书文档:

1. 把完整 plan 内容(plan 字段原文,markdown 格式)写到 /tmp/plan-${Date.now()}.md
2. 决定标题:取 plan 第一行的一级标题(以 # 开头,去掉 # 和首尾空格)。如果 plan 不以 # 开头,用 plan 内容前 30 字符(去除换行/标点)作为标题
3. 调 \`node .claude/skills/feishu-project/scripts/archive.js create-doc --title "[plan] {上述标题}" --file /tmp/plan-xxx.md\`(脚本会自动按 [plan] 类别归档到 wiki + 批量授权)
4. 解析 stdout JSON,读出 \`url\` 字段(归档后的飞书 wiki 链接;字段名就是 \`url\`,不是 \`doc_url\`)
5. 最终回复 ≤500 字,只输出:
   - 一句话目标摘要
   - 飞书文档链接(用 markdown 格式 [上述标题](url))
   - 最多 3 条关键决策点/参数(列表形式)
   - 末尾一句:"请确认是否按此推进,或回复修改建议"

强约束(已通过 disallowedTools 在 CLI 层禁用):
- **禁止**再次调用 ExitPlanMode
- **禁止**调用 AskUserQuestion(用户已在等结果,直接给文档+摘要)
- **不要**把 plan 全文重复到回复里(全文已在飞书文档)`

  try {
    const { promise, abort } = claudeBridge.callClaude(archivePrompt, {
      sessionId: result.sessionId,
      model: ctx.session?.model,
      sessionKey: ctx.sessionKey,
      disableInteraction: true,  // CLI 层禁 AskUserQuestion + EnterPlanMode
      onStep: (step) => sessionManager.appendStep(ctx.sessionKey, step, ctx.msgIndex),
    })
    if (ctx.messageId) {
      activeProcessing.set(ctx.messageId, {
        abort,
        sessionKey: ctx.sessionKey,
        msgIndex: ctx.msgIndex,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        openId: ctx.openId,
        userId: ctx.userId,
      })
    }
    const archiveResult = await promise
    if (ctx.messageId) activeProcessing.delete(ctx.messageId)

    // 用户撤回导致的 abort：上传信号让调用方走撤回分支（不发原 plan）
    if (archiveResult.aborted) {
      console.log(`${ctx.logPrefix} 长 plan resume 被 abort（用户撤回）`)
      return { aborted: true }
    }
    if (!archiveResult.result?.trim()) {
      console.warn(`${ctx.logPrefix} 长 plan resume 空结果，降级直发原 plan`)
      return null
    }
    console.log(`${ctx.logPrefix} 长 plan 建文档完成 (回复 ${archiveResult.result.length}字)`)
    return archiveResult
  } catch (e) {
    if (ctx.messageId) activeProcessing.delete(ctx.messageId)
    console.warn(`${ctx.logPrefix} 长 plan resume 失败，降级直发原 plan: ${e.message}`)
    return null
  }
}

// --- 活跃处理追踪（用于撤回取消 + 重启恢复）---
// messageId → { abort, sessionKey, msgIndex, chatId, chatType, openId, userId }
const activeProcessing = new Map()
const ACTIVE_TASKS_FILE = path.join(__dirname, '../../data/active-tasks.json')

// --- 消息去重 ---

const processedEvents = new Set()
const EVENT_DEDUP_TTL = 5 * 60 * 1000

function isDuplicate(eventId) {
  if (!eventId) return false
  if (processedEvents.has(eventId)) return true
  processedEvents.add(eventId)
  setTimeout(() => processedEvents.delete(eventId), EVENT_DEDUP_TTL)
  return false
}

// --- 消息内容解析 ---

// post 富文本段落内单个 element → 字符串
// 已知 tag 按语义渲染；未知 tag 有 el.text 就取，避免未来新 tag 被静默丢失
function renderPostElement(el) {
  if (!el || typeof el !== 'object') return ''
  switch (el.tag) {
    case 'text':     return el.text || ''
    case 'a':        return el.text || el.href || ''
    case 'at':       return el.user_name ? `@${el.user_name}` : ''
    case 'markdown': return el.text || ''
    case 'hr':       return '\n---\n'
    case 'img':
    case 'emotion':
    case 'media':
      return ''
    case 'code_block':
    case 'code': {
      const body = el.text || ''
      if (!body) return ''
      return `\n\`\`\`${el.language || ''}\n${body}\n\`\`\`\n`
    }
    default:
      return typeof el.text === 'string' ? el.text : ''
  }
}

function extractTextContent(message) {
  if (!message || !message.content) return ''
  try {
    const content = JSON.parse(message.content)
    const msgType = message.message_type || message.msg_type || 'text'

    if (msgType === 'interactive') {
      return formatCardSummary(content)
    }
    if (msgType === 'post') {
      const lines = []
      // 事件推送格式: {"title":"...", "content":[[...]]}
      // getMessage API 格式: {"zh_cn": {"title":"...", "content":[...]}}
      const lang = content.content
        ? content
        : (content.zh_cn || content.en_us || Object.values(content)[0] || {})
      if (lang.title) lines.push(lang.title)
      for (const para of (lang.content || [])) {
        const paraText = para.map(renderPostElement).join('')
        if (paraText) lines.push(paraText)
      }
      return lines.join('\n') || ''
    }
    // text 类型或 fallback
    if (content.text) {
      return content.text.replace(/@_user_\d+/g, '').trim()
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 提取消息内容（文本 + 媒体资源引用）
 * @returns {{ text: string, resources: Array<{fileKey: string, type: 'image'|'file', fileName?: string}> }}
 */
function extractMessageContent(message) {
  if (!message || !message.content) return { text: '', resources: [] }
  try {
    const content = JSON.parse(message.content)
    const msgType = message.message_type || message.msg_type || 'text'

    if (msgType === 'image') {
      return {
        text: '',
        resources: content.image_key ? [{ fileKey: content.image_key, type: 'image' }] : [],
      }
    }

    if (msgType === 'file') {
      return {
        text: '',
        resources: content.file_key
          ? [{ fileKey: content.file_key, type: 'file', fileName: content.file_name }]
          : [],
      }
    }

    if (msgType === 'post') {
      const lines = []
      const resources = []
      const lang = content.content
        ? content
        : (content.zh_cn || content.en_us || Object.values(content)[0] || {})
      if (lang.title) lines.push(lang.title)
      for (const para of (lang.content || [])) {
        const paraText = para.map(renderPostElement).join('')
        if (paraText) lines.push(paraText)
        for (const el of para) {
          if (el.tag === 'img' && el.image_key) {
            resources.push({ fileKey: el.image_key, type: 'image' })
          }
        }
      }
      return { text: lines.join('\n') || '', resources }
    }

    // text / interactive / 其他：复用 extractTextContent，无资源
    return { text: extractTextContent(message), resources: [] }
  } catch {
    return { text: '', resources: [] }
  }
}

// --- 获取话题根消息 ---
// 只通过 getMessage 获取根消息（仅需 im:message 权限），
// 不依赖 listChatMessages（需要 im:message.group_msg 权限）。
// 多轮对话历史由 Claude --resume sessionId 维护。

async function fetchRootMessage(rootId) {
  if (!rootId) return null
  try {
    const res = await messageSender.getMessage(rootId)
    if (res.code === 0 && res.data?.items?.length) {
      return res.data.items[0]
    }
  } catch (err) {
    console.error('[webhook] fetchRootMessage error:', err.message)
  }
  return null
}

function extractMsgText(msg) {
  const msgType = msg.msg_type
  const body = msg.body?.content
  if (!body) return `[${msgType}消息]`

  try {
    if (msgType === 'text') {
      const parsed = JSON.parse(body)
      return (parsed.text || '').replace(/@_user_\d+/g, '').trim() || '[空文本]'
    }
    if (msgType === 'interactive') {
      const card = JSON.parse(body)
      return formatCardSummary(card)
    }
    if (msgType === 'post') {
      const post = JSON.parse(body)
      const lines = []
      const lang = post.zh_cn || post.en_us || Object.values(post)[0] || {}
      if (lang.title) lines.push(lang.title)
      for (const para of (lang.content || [])) {
        const paraText = para.map(renderPostElement).join('')
        if (paraText) lines.push(paraText)
      }
      return lines.join('\n') || '[富文本消息]'
    }
    if (msgType === 'image') return '[图片消息]'
    if (msgType === 'file') {
      const parsed = JSON.parse(body)
      return `[文件消息: ${parsed.file_name || '未知文件'}]`
    }
    return `[${msgType}消息]`
  } catch {
    return `[${msgType}消息]`
  }
}

/**
 * 从 getMessage API 返回的消息对象中提取资源引用（用于话题根消息）
 */
function extractMsgResources(msg) {
  const msgType = msg.msg_type
  const body = msg.body?.content
  if (!body) return []
  try {
    const content = JSON.parse(body)
    if (msgType === 'image' && content.image_key) {
      return [{ fileKey: content.image_key, type: 'image' }]
    }
    if (msgType === 'file' && content.file_key) {
      return [{ fileKey: content.file_key, type: 'file', fileName: content.file_name }]
    }
    if (msgType === 'post') {
      const resources = []
      const lang = content.zh_cn || content.en_us || Object.values(content)[0] || {}
      for (const para of (lang.content || [])) {
        for (const el of para) {
          if (el.tag === 'img' && el.image_key) {
            resources.push({ fileKey: el.image_key, type: 'image' })
          }
        }
      }
      return resources
    }
  } catch {}
  return []
}

function formatCardSummary(card) {
  const parts = []
  if (card.header?.title?.content) parts.push(`[卡片] ${card.header.title.content}`)
  if (card.header?.subtitle?.content) parts.push(card.header.subtitle.content)

  const elements = card.body?.elements || card.elements || []

  // Post-like 格式：elements 是段落数组（数组的数组），如 fmonitor 告警卡片
  if (elements.length > 0 && Array.isArray(elements[0])) {
    if (card.title) parts.push(card.title)
    const allText = elements.flat().map(renderPostElement).join('')
    if (allText.trim()) parts.push(allText.trim())
    return parts.join('\n') || JSON.stringify(card).slice(0, 500)
  }

  // 标准卡片格式：elements 是 {tag: "div"/"markdown"/...} 对象数组
  const texts = extractCardTexts(elements)
  if (texts.length) parts.push(texts.join('\n'))
  return parts.join('\n') || JSON.stringify(card).slice(0, 500)
}

function extractCardTexts(elements) {
  const texts = []
  for (const el of elements) {
    if (el.tag === 'markdown' && el.content) {
      texts.push(el.content)
    } else if (el.tag === 'div') {
      if (el.text?.content) texts.push(el.text.content)
      if (Array.isArray(el.fields)) {
        for (const field of el.fields) {
          if (field.text?.content) texts.push(field.text.content)
        }
      }
    } else if (el.tag === 'rich_text' || el.tag === 'column_set' || el.tag === 'column') {
      const children = el.elements || el.columns || []
      texts.push(...extractCardTexts(children))
    } else if (el.tag === 'note') {
      for (const child of (el.elements || [])) {
        if (child.content) texts.push(child.content)
        else if (child.text?.content) texts.push(child.text.content)
      }
    } else if (el.text?.content) {
      texts.push(el.text.content)
    }
  }
  return texts
}

// --- 判断是否需要响应 ---

function shouldRespond(data) {
  const message = data.message
  if (!message) return false

  const chatType = message.chat_type

  // 私聊：始终响应
  if (chatType === 'p2p') return true

  // 群聊：仅当显式 @ 机器人本身时响应
  // 注意：@所有人 也会触发推送，且消息可能同时 @ 其他真实用户（会议纪要场景）；
  // 因此必须以「mentions 中是否包含 bot 自己的 open_id」为准，而非「是否 @ 了任何真实用户」
  if (chatType === 'group') {
    const mentions = message.mentions || []
    const botOpenId = messageSender.getBotOpenId()
    if (botOpenId) {
      const mentioned = mentions.some(m => m && m.id && m.id.open_id === botOpenId)
      if (!mentioned && mentions.length > 0) {
        console.log(`[msg] 群消息未 @ 机器人，忽略 chat=${message.chat_id || ''}`)
      }
      return mentioned
    }
    // 降级：bot open_id 尚未拉到时，沿用旧的 @所有人 过滤逻辑（避免完全失声）
    const realMentions = mentions.filter(m => {
      if (!m) return false
      if (m.key === '@_all') return false
      if (m.name === '所有人') return false
      if (!m.id || !m.id.open_id) return false
      return true
    })
    if (mentions.length > 0 && realMentions.length === 0) {
      console.log(`[msg] 忽略 @所有人 消息 chat=${message.chat_id || ''}`)
    }
    return realMentions.length > 0
  }

  return false
}

// --- 事件处理函数（被 EventDispatcher 调用）---
// 注意：飞书长连接要求 3 秒内处理完事件，否则触发超时重推。
// 因此这里不 await，让事件回调立即返回，Claude 调用在后台异步执行。

function handleMessageEvent(data) {
  processMessage(data).catch(err => {
    console.error('[webhook] processMessage error:', err)
  })
}

// --- 消息处理核心流程 ---

async function processMessage(data) {
  if (!shouldRespond(data)) return

  const message = data.message
  const sender = data.sender || {}
  const senderId = sender.sender_id || {}
  const userId = senderId.user_id || senderId.open_id || ''
  const openId = senderId.open_id || ''
  const chatId = message.chat_id || ''
  const chatType = message.chat_type || ''
  console.log(`[setup] chatId=${chatId} chatType=${chatType}`)
  const messageId = message.message_id || ''
  const rootId = message.root_id || '' // 话题根消息 ID
  const parentId = message.parent_id || '' // 被引用/回复的消息 ID
  const { text, resources: msgResources } = extractMessageContent(message)
  const resources = [...msgResources]

  if (!text && resources.length === 0) return

  // 消息去重（长连接模式下可能存在重推）
  if (isDuplicate(messageId)) return

  // 学习用户 userId → openId 映射
  if (userId && openId) userCache.learn(userId, openId)

  // 群聊先取 isSoloGroup 决定 sessionKey 走 chat: 还是 thread: 预创话题
  const isSoloGroup = chatType === 'group' && chatId
    ? await chatInfoCache.isSoloGroup(chatId)
    : false
  const replyOpts = await getReplyOpts(chatType, chatId) // cache 命中，与其他路径统一来源

  const sessionKey = sessionManager.makeKey(chatType, chatId, rootId, userId, messageId, { isSoloGroup })

  console.log(`[msg] user=${userId} chat=${chatId} root=${rootId} parent=${parentId} solo=${isSoloGroup} key=${sessionKey} text="${text.slice(0, 80)}"`)

  // 群聊回复时 @用户
  const replyContent = (replyText) => {
    if (chatType === 'group' && openId) {
      return messageSender.textContent(`<at user_id="${openId}">${userId}</at>\n${replyText}`)
    }
    return messageSender.textContent(replyText)
  }

  // 处理命令（命令优先于 pending question，确保 /new 等命令始终可用）
  const cmdResult = handleCommand(text, userId, sessionKey, {
    chatId,
    userId,
    executor: executeCronJob,
  })
  if (cmdResult.handled) {
    await messageSender.replyMessage(messageId, replyContent(cmdResult.response), 'text', replyOpts)
    return
  }

  // 检查是否有待回答的 AskUserQuestion — 如果有，将消息视为回答而非新问题
  if (text && interactionManager.hasPendingQuestion(sessionKey)) {
    await handleQuestionAnswer(sessionKey, messageId, text, openId, chatType)
    return
  }

  // 权限检查
  if (!checkPermission(userId, 'query')) {
    await messageSender.replyMessage(messageId, replyContent('权限不足，无法执行查询。'), 'text', replyOpts)
    return
  }

  // 纯资源消息（无文字）：只下载保存，不调用 Claude
  if (!text && resources.length > 0) {
    const results = await Promise.all(
      resources.map(r => resourceDownloader.downloadResource(messageId, r.fileKey, r.type, r.fileName))
    )
    const downloaded = results.filter(Boolean)
    if (downloaded.length > 0) {
      for (const f of downloaded) {
        resourceDownloader.registerFile(sessionKey, f.filePath)
      }
      const names = downloaded.map(f => f.originalName).join('、')
      console.log(`[msg] 纯资源消息，已保存 ${downloaded.length} 个文件`)
      await messageSender.addReaction(messageId, 'DONE').catch(() => {})
    }
    return
  }

  // 添加处理中反应（若消息已被撤回则直接跳过）
  let reactionId = null
  try {
    reactionId = await messageSender.addProcessingReaction(messageId)
  } catch (err) {
    const errData = err.response?.data
    if (errData?.code === 231003 || errData?.code === 230011) {
      console.log(`[msg] 消息 ${messageId} 已被撤回，跳过处理`)
      return
    }
    console.error('[msg] Failed to add reaction:', err.message)
  }

  let msgIndex = -1
  try {
    // 获取/创建 session
    const session = sessionManager.getOrCreateSession(sessionKey)

    // 开始处理：立即记录用户消息 + 创建 processing 占位（返回消息索引）
    msgIndex = sessionManager.startProcessing(sessionKey, text)

    // 注入话题根消息上下文（如告警卡片等）+ 提取根消息中的资源
    let contextText = text
    let rootText = ''
    if (rootId && rootId !== messageId) {
      const rootMsg = await fetchRootMessage(rootId)
      if (rootMsg) {
        rootText = extractMsgText(rootMsg)
        // 根消息中的资源也需要下载（如用户引用了图片/文件消息）
        const rootMsgId = rootMsg.message_id || rootId
        const rootResources = extractMsgResources(rootMsg)
        for (const r of rootResources) {
          r.messageId = rootMsgId
        }
        if (rootResources.length > 0) {
          resources.push(...rootResources)
          console.log(`[msg] 根消息包含 ${rootResources.length} 个资源`)
        }
      }
    }

    // 获取被引用/回复的消息（parent_id 指向的消息，与根消息不同时才获取）
    let quotedText = ''
    if (parentId && parentId !== rootId && parentId !== messageId) {
      const quotedMsg = await fetchRootMessage(parentId)
      if (quotedMsg) {
        quotedText = extractMsgText(quotedMsg)
        const quotedMsgId = quotedMsg.message_id || parentId
        const quotedResources = extractMsgResources(quotedMsg)
        for (const r of quotedResources) { r.messageId = quotedMsgId }
        if (quotedResources.length > 0) {
          resources.push(...quotedResources)
          console.log(`[msg] 引用消息包含 ${quotedResources.length} 个资源`)
        }
      }
    }

    // 组装上下文
    if (rootText || quotedText) {
      const parts = []
      if (rootText) {
        parts.push(`[话题原始消息]`, rootText, `---`)
        console.log(`[msg] 注入话题根消息上下文`)
      }
      if (quotedText) {
        parts.push(`[引用消息]`, quotedText, `---`)
        console.log(`[msg] 注入引用消息上下文`)
      }
      parts.push(`用户最新消息: ${text}`)
      contextText = parts.join('\n')
    }

    // 下载媒体资源（图片/文件）
    let promptText = contextText
    const newFilePaths = new Set()
    if (resources.length > 0) {
      const results = await Promise.all(
        resources.map(r => resourceDownloader.downloadResource(r.messageId || messageId, r.fileKey, r.type, r.fileName))
      )
      const downloaded = results.filter(Boolean)
      for (const f of downloaded) {
        resourceDownloader.registerFile(sessionKey, f.filePath)
        newFilePaths.add(f.filePath)
      }
      if (downloaded.length > 0) {
        const hints = downloaded.map(f => {
          if (f.type === 'image') return `[图片文件: ${f.filePath}]（请使用 Read 工具查看此图片）`
          return `[文件: ${f.originalName}, 路径: ${f.filePath}]（请使用 Read 工具查看此文件）`
        }).join('\n')
        promptText = `${hints}\n\n${promptText}`
      }
    }

    // 注入 session 中已有的历史文件（之前消息发送的，本次未重复下载的）
    const sessionFiles = resourceDownloader.getSessionFiles(sessionKey)
      .filter(f => !newFilePaths.has(f))
    if (sessionFiles.length > 0) {
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']
      const historyHints = sessionFiles.map(f => {
        if (imageExts.includes(path.extname(f).toLowerCase())) return `[会话历史图片: ${f}]`
        return `[会话历史文件: ${path.basename(f)}, 路径: ${f}]`
      }).join('\n')
      promptText = `${historyHints}\n\n${promptText}`
    }

    // 注入用户身份
    const claudePrompt = userId
      ? `[当前提问用户: ${userId}]\n${promptText}`
      : promptText

    // 调用 Claude（实时回调每个步骤，按 msgIndex 隔离并发处理）
    const { promise, abort, sessionId: claudeSessionId } = claudeBridge.callClaude(claudePrompt, {
      sessionId: session.sessionId,
      model: session.model,
      sessionKey,
      onStep: (step) => sessionManager.appendStep(sessionKey, step, msgIndex),
    })
    // 立即更新 sessionId（新会话时为预分配的 UUID，确保重启时可 resume）
    if (claudeSessionId && !session.sessionId) {
      sessionManager.updateSession(sessionKey, { sessionId: claudeSessionId })
    }
    activeProcessing.set(messageId, { abort, sessionKey, msgIndex, chatId, chatType, openId, userId })

    const result = await promise
    activeProcessing.delete(messageId)
    resourceDownloader.ingestSessionRegistrations(sessionKey)

    // AskUserQuestion 触发的中断 → 发送飞书交互卡片
    if (result.aborted && result.askUserQuestion) {
      const MAX_QUESTIONS = 4
      let questions = result.askUserQuestion.questions || []
      if (!Array.isArray(questions) || questions.length === 0) {
        console.warn(`[msg] AskUserQuestion 格式异常，跳过: ${JSON.stringify(result.askUserQuestion).slice(0, 200)}`)
        sessionManager.cancelProcessing(sessionKey, msgIndex)
        await messageSender.replaceReaction(messageId, reactionId, 'DONE').catch(() => {})
        await messageSender.replyMessage(messageId, messageSender.textContent('Claude 请求确认但问题格式异常，请重试或 /new 重置会话。'), 'text', replyOpts)
        return
      }
      if (questions.length > MAX_QUESTIONS) {
        console.warn(`[msg] AskUserQuestion 问题数异常: ${questions.length}，截断为 ${MAX_QUESTIONS}`)
        questions = questions.slice(0, MAX_QUESTIONS)
      }
      console.log(`[msg] AskUserQuestion 检测到 ${questions.length} 个问题，发送卡片`)

      // 更新 session 的 sessionId（abort 也会返回 sessionId）
      if (result.sessionId) {
        sessionManager.updateSession(sessionKey, { sessionId: result.sessionId })
      }

      // 发送飞书卡片（传 sessionKey 生成可点击按钮）
      const card = messageSender.buildQuestionCard(questions, sessionKey)
      const cardRes = await messageSender.replyMessage(messageId, JSON.stringify(card), 'interactive', replyOpts)
      const cardMsgId = cardRes?.data?.message_id

      // 注册待回答问题（含聊天上下文，按钮点击时需要）
      interactionManager.setPendingQuestion(sessionKey, {
        questions,
        sessionId: result.sessionId || session.sessionId,
        model: session.model,
        chatId, chatType, openId, userId, messageId, cardMessageId: cardMsgId,
      })

      // 记录到会话消息
      sessionManager.finishProcessing(sessionKey, '[等待用户确认...]', msgIndex)

      // 替换反应为"等待中"
      await messageSender.replaceReaction(messageId, reactionId, 'THUMBSUP').catch(() => {})
      return
    }

    // 被撤回取消的请求，静默退出
    if (result.aborted) {
      console.log(`[msg] 消息 ${messageId} 处理已取消`)
      sessionManager.cancelProcessing(sessionKey, msgIndex)
      await messageSender.replaceReaction(messageId, reactionId, 'HEART').catch(() => {})
      return
    }

    // 处理结果（长内容由 Claude 自行创建飞书文档，此处直接透传）
    let replyText = result.result

    // 防护：检测疑似冗余/敷衍回复 — result 极短但前面有更丰富的内容
    // 注意：finishProcessing 延后到 self-review 之后调用，确保 review 期间 appendStep 正常记录
    replyText = fixTruncatedReply(replyText, result.steps, '[msg]')

    // 长 plan 兜底：plan>1000 字时 resume Claude 建飞书文档
    const archived = await maybeArchiveLongPlan(result, {
      session, sessionKey, msgIndex, messageId, chatId, chatType, openId, userId,
      logPrefix: '[msg:plan]',
    })
    if (archived?.aborted) {
      // archive 期间用户撤回原消息：走撤回退出，不发任何回复
      sessionManager.cancelProcessing(sessionKey, msgIndex)
      await messageSender.replaceReaction(messageId, reactionId, 'HEART').catch(() => {})
      return
    }
    if (archived) {
      replyText = archived.result
      result.usage = archived.usage || result.usage
      result.lastTurnUsage = archived.lastTurnUsage || result.lastTurnUsage
      result.costUsd = (result.costUsd || 0) + (archived.costUsd || 0)
      result.sessionId = archived.sessionId || result.sessionId
    }

    // 空回复异常：CLI 没产出最终 text，走 resume 让模型补一段最终回复
    // 注：短回复 + 前面有更长内容的场景已由 fixTruncatedReply 兜底，此处不再重复判定
    if (result.sessionId && !replyText.trim()) {
      console.log(`[msg] empty resume 触发 (steps=${result.steps?.length || 0})`)
      try {
        const reviewPrompt = '继续。（上一轮没有产出回复，可能任务被中途打断了，请继续完成。）'
        const { promise: reviewPromise, abort: reviewAbort } = claudeBridge.callClaude(reviewPrompt, {
          sessionId: result.sessionId,
          model: session.model,
          sessionKey,
          onStep: (step) => sessionManager.appendStep(sessionKey, step, msgIndex),
        })
        // 注册 review 进程到 activeProcessing，支持用户撤回取消
        activeProcessing.set(messageId, { abort: reviewAbort, sessionKey, msgIndex, chatId, chatType, openId, userId })
        const reviewResult = await reviewPromise
        activeProcessing.delete(messageId)
        if (reviewResult.result && reviewResult.result.trim().length > 0) {
          console.log(`[msg] empty resume 补全成功(${reviewResult.result.length}字)`)
          replyText = reviewResult.result
          if (reviewResult.usage) {
            result.usage = reviewResult.usage
            result.lastTurnUsage = reviewResult.lastTurnUsage || null
            result.costUsd = reviewResult.costUsd
          }
        }
      } catch (reviewErr) {
        activeProcessing.delete(messageId)
        console.warn(`[msg] empty resume 失败:`, reviewErr.message)
      }
    }

    // 完成处理：填充最终结果（在 self-review 之后，确保写入最终文本）
    sessionManager.finishProcessing(sessionKey, replyText, msgIndex)

    // 更新 session
    sessionManager.updateSession(sessionKey, {
      sessionId: result.sessionId,
      usage: result.usage,
      lastTurnUsage: result.lastTurnUsage,
      costUsd: result.costUsd,
    })

    replyText += buildContextFooter(result)

    // 空结果保护
    if (!replyText || !replyText.trim()) {
      console.warn('[msg] Claude 返回空结果，使用兜底提示')
      replyText = '处理完成，但未生成有效回复内容。请尝试重新描述你的需求，或使用 /new 重置会话后重试。'
    }

    // 解析附件协议标记（[[ATTACH_FILE|IMAGE:path]]），剥离后得到纯文本和附件列表
    const { text: cleanReply, attachments } = parseAttachments(replyText)

    // 格式化回复（智能判断卡片/文本）
    const { content: formattedReply, msgType: replyMsgType } = markdownToCard.formatReply(cleanReply || replyText, {
      openId, userId, isGroup: chatType === 'group',
    })

    // 回复消息
    try {
      if (cleanReply || !attachments.length) {
        await messageSender.replyMessage(messageId, formattedReply, replyMsgType, replyOpts)
      }
    } catch (replyErr) {
      // 消息已被撤回（not found / deleted）：标记为已取消，静默退出
      const errData = replyErr.response?.data
      if (errData?.code === 231003 || errData?.code === 230011) {
        console.log(`[msg] 消息 ${messageId} 已被撤回，跳过回复`)
        sessionManager.updateMessageText(sessionKey, msgIndex, '[已取消 - 消息已撤回]')
        activeProcessing.delete(messageId)
        return
      }
      console.error('[msg] Reply failed:', replyErr.message)
      // 重试用纯文本（最大化可靠性）
      const truncated = truncateForFeishu(cleanReply || replyText)
      await messageSender.replyMessage(messageId, replyContent(truncated), 'text', replyOpts)
    }

    // 逐个发送附件（失败不中断，仅记录）
    // 走 reply 路径让附件落到原消息所在话题，与文本回复一致
    const attachOpts = { replyToMessageId: messageId, ...(replyOpts || {}) }
    for (const att of attachments) {
      try {
        if (att.type === 'file') await messageSender.sendFile(chatId, att.path, attachOpts)
        else if (att.type === 'image') await messageSender.sendImage(chatId, att.path, attachOpts)
        console.log(`[attach] Sent ${att.type}: ${att.path}`)
      } catch (e) {
        console.error(`[attach] Failed to send ${att.type} ${att.path}: ${e.message}`)
      }
    }

    // 替换反应：处理中 → 完成
    await messageSender.replaceReaction(messageId, reactionId, 'DONE')

  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : ''
    console.error(`[msg] Claude error: ${err.message}`, errDetail)

    activeProcessing.delete(messageId)

    // 取消 processing 占位（按 msgIndex 定位）
    sessionManager.cancelProcessing(sessionKey, msgIndex)

    const errMsg = `处理出错：${err.message.slice(0, 200)}\n\n请稍后重试，或使用 /new 重置会话。`
    await messageSender.replyMessage(messageId, replyContent(errMsg), 'text', replyOpts).catch(() => {})

    // 替换反应：处理中 → 错误
    await messageSender.replaceReaction(messageId, reactionId, 'HEART').catch(() => {})
  }
}

// --- AskUserQuestion 回答处理 ---

/**
 * 将用户回复的文字解析为 AskUserQuestion 的答案文本
 */
function formatAnswer(questions, answerText) {
  const lines = []
  for (const q of questions) {
    lines.push(`问题: ${q.question}`)
    const opts = q.options || []

    // 尝试将数字映射到选项（支持 "1" "1,3" "1 3" "1，3"）
    const nums = answerText.trim().split(/[,，\s]+/).map(s => parseInt(s, 10) - 1)
    const validNums = nums.filter(n => !isNaN(n) && n >= 0 && n < opts.length)

    if (validNums.length > 0) {
      const selected = validNums.map(n => `${opts[n].label}${opts[n].description ? ' — ' + opts[n].description : ''}`)
      lines.push(`用户选择: ${selected.join('; ')}`)
    } else {
      lines.push(`用户回答: ${answerText}`)
    }
  }
  return lines.join('\n')
}

function formatButtonAnswers(questions, answers) {
  const lines = []
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    const a = answers[qi]
    lines.push(`问题: ${q.question}`)
    if (typeof a === 'number') {
      const opt = (q.options || [])[a]
      const label = opt ? opt.label : `选项 ${a + 1}`
      const desc = opt?.description ? ` — ${opt.description}` : ''
      lines.push(`用户选择: ${label}${desc}`)
    } else {
      lines.push(`用户回答: ${a}`)
    }
  }
  return lines.join('\n')
}

/**
 * 处理用户文字回复 AskUserQuestion
 * 单问题：直接消费并 resume
 * 多问题：文字回复只应用到第一个未答问题，未全答则更新卡片等待继续
 */
async function handleQuestionAnswer(sessionKey, messageId, answerText, openId, chatType) {
  const peek = interactionManager.getPendingQuestion(sessionKey)
  if (!peek) return
  const questions = peek.questions || []

  // 单问题：保持原有行为
  if (questions.length <= 1) {
    const pending = interactionManager.consumePendingQuestion(sessionKey)
    if (!pending) return
    console.log(`[msg] 收到 AskUserQuestion 文字回答: "${answerText.slice(0, 80)}" sessionKey=${sessionKey}`)
    await executeQuestionAnswer(sessionKey, answerText, pending, {
      messageId, chatId: pending.chatId, chatType, openId,
    })
    return
  }

  // 多问题：找第一个未答的问题
  const answers = peek.answers || {}
  let targetQi = -1
  for (let i = 0; i < questions.length; i++) {
    if (answers[i] == null) { targetQi = i; break }
  }
  if (targetQi < 0) return // 理论上不会到这里

  // 匹配选项编号或存自定义文本
  const q = questions[targetQi]
  const opts = q.options || []
  const num = parseInt(answerText.trim(), 10) - 1
  const answerValue = (!isNaN(num) && num >= 0 && num < opts.length) ? num : answerText.trim()

  const result = interactionManager.answerQuestion(sessionKey, targetQi, answerValue)
  if (!result) return

  const displayAnswer = typeof answerValue === 'number'
    ? (opts[answerValue]?.label || answerText) : answerText
  console.log(`[msg] 文字回答问题 ${targetQi + 1}/${questions.length}: "${displayAnswer}" sessionKey=${sessionKey}`)

  if (result.allAnswered) {
    const pending = interactionManager.consumePendingQuestion(sessionKey)
    if (!pending) return
    pending.buttonAnswers = result.answers

    // 更新卡片为全部已答
    if (pending.cardMessageId) {
      messageSender.patchCard(pending.cardMessageId, messageSender.buildAllAnsweredCard(questions, result.answers)).catch(err => {
        console.error('[msg] 更新卡片失败:', err.message)
      })
    }

    // 组合所有回答
    const answerParts = []
    for (let i = 0; i < questions.length; i++) {
      const a = result.answers[i]
      if (typeof a === 'number') {
        const selectedOpt = (questions[i].options || [])[a]
        answerParts.push(selectedOpt ? selectedOpt.label : String(a + 1))
      } else {
        answerParts.push(String(a))
      }
    }
    await executeQuestionAnswer(sessionKey, answerParts.join(', '), pending, {
      messageId, chatId: pending.chatId, chatType, openId,
    })
  } else {
    // 部分已答 — 更新卡片
    if (peek.cardMessageId) {
      messageSender.patchCard(peek.cardMessageId, messageSender.buildPartialAnsweredCard(questions, result.answers, sessionKey)).catch(err => {
        console.error('[msg] 更新卡片失败:', err.message)
      })
    }
    // 回复提示继续回答（用 pending 创建时的 chatType/chatId 配对，不依赖当前事件）
    const opts = await getReplyOpts(peek.chatType || chatType, peek.chatId)
    await messageSender.replyMessage(messageId,
      messageSender.textContent(`已回答问题 ${targetQi + 1}，请继续回答剩余问题（点击按钮或文字回复）`),
      'text', opts)
  }
}

/**
 * 核心：消费 pending question 后的 Claude resume 逻辑
 * 文字回复和按钮点击共用此函数
 * @param {object} ctx - { messageId?, chatId, chatType, openId }
 *   messageId 存在时用 replyMessage（话题内回复），不存在时用 sendMessage
 */
async function executeQuestionAnswer(sessionKey, answerText, pending, ctx) {
  const formattedAnswer = pending.buttonAnswers
    ? formatButtonAnswers(pending.questions, pending.buttonAnswers)
    : formatAnswer(pending.questions, answerText)
  const resumePrompt = [
    `[系统消息：用户已回答你之前的提问，请根据回答继续执行]`,
    ``,
    formattedAnswer,
    ``,
    `请根据用户的回答继续之前的任务。不要重复提问。`,
  ].join('\n')

  // 回复方式：文字回复 → replyMessage，按钮点击 → sendMessage
  // 附件协议：reply 末尾的 [[ATTACH_FILE:/tmp/x]] / [[ATTACH_IMAGE:/tmp/y]] 会被剥离并逐个发送
  const sendReply = async (text) => {
    const { text: cleanText, attachments } = parseAttachments(text)
    const opts = ctx.messageId ? await getReplyOpts(ctx.chatType, ctx.chatId) : null
    if (cleanText) {
      const { content, msgType } = markdownToCard.formatReply(cleanText, {
        openId: ctx.openId, userId: 'user', isGroup: ctx.chatType === 'group',
      })
      if (ctx.messageId) {
        await messageSender.replyMessage(ctx.messageId, content, msgType, opts)
      } else {
        await messageSender.sendMessage('chat_id', ctx.chatId, content, msgType)
      }
    }
    // 附件走 reply 路径，与文本一致落到原消息所在话题；无 messageId 时回退直发
    const attachOpts = ctx.messageId ? { replyToMessageId: ctx.messageId, ...(opts || {}) } : {}
    for (const att of attachments) {
      try {
        if (att.type === 'file') await messageSender.sendFile(ctx.chatId, att.path, attachOpts)
        else if (att.type === 'image') await messageSender.sendImage(ctx.chatId, att.path, attachOpts)
        console.log(`[attach] Sent ${att.type}: ${att.path}`)
      } catch (e) {
        console.error(`[attach] Failed to send ${att.type} ${att.path}: ${e.message}`)
      }
    }
  }

  // 发送卡片方式
  const sendCard = async (cardJson) => {
    const content = JSON.stringify(cardJson)
    if (ctx.messageId) {
      const opts = await getReplyOpts(ctx.chatType, ctx.chatId)
      return messageSender.replyMessage(ctx.messageId, content, 'interactive', opts)
    }
    return messageSender.sendMessage('chat_id', ctx.chatId, content, 'interactive')
  }

  let reactionId = null
  if (ctx.messageId) {
    try { reactionId = await messageSender.addProcessingReaction(ctx.messageId) } catch {}
  }

  const session = sessionManager.getOrCreateSession(sessionKey)
  const msgIndex = sessionManager.startProcessing(sessionKey, `[回答确认] ${answerText}`)

  try {
    const { promise, abort } = claudeBridge.callClaude(resumePrompt, {
      sessionId: pending.sessionId,
      model: pending.model || session.model,
      sessionKey,
      onStep: (step) => sessionManager.appendStep(sessionKey, step, msgIndex),
    })
    if (ctx.messageId) {
      activeProcessing.set(ctx.messageId, { abort, sessionKey, msgIndex, chatId: ctx.chatId, chatType: ctx.chatType, openId: ctx.openId, userId: ctx.userId || '' })
    }

    const result = await promise
    if (ctx.messageId) activeProcessing.delete(ctx.messageId)
    resourceDownloader.ingestSessionRegistrations(sessionKey)

    // AskUserQuestion 再次触发（连续提问）
    if (result.aborted && result.askUserQuestion) {
      let questions = result.askUserQuestion.questions || []
      if (!Array.isArray(questions) || questions.length === 0) {
        console.warn(`[msg] AskUserQuestion 连续提问格式异常，跳过。raw: ${JSON.stringify(result.askUserQuestion).slice(0, 200)}`)
        sessionManager.cancelProcessing(sessionKey, msgIndex)
        if (ctx.messageId && reactionId) {
          await messageSender.replaceReaction(ctx.messageId, reactionId, 'HEART').catch(() => {})
        }
        await sendReply('Claude 请求确认但问题格式异常，请重试或 /new 重置会话。').catch(() => {})
        return
      }
      if (questions.length > 4) {
        console.warn(`[msg] AskUserQuestion 连续提问问题数异常: ${questions.length}，截断为 4`)
        questions = questions.slice(0, 4)
      }
      console.log(`[msg] AskUserQuestion 连续提问，再次发送卡片`)

      if (result.sessionId) {
        sessionManager.updateSession(sessionKey, { sessionId: result.sessionId })
      }
      sessionManager.finishProcessing(sessionKey, '[等待用户确认...]', msgIndex)
      const card = messageSender.buildQuestionCard(questions, sessionKey)
      const cardRes = await sendCard(card)
      const cardMsgId = cardRes?.data?.message_id
      interactionManager.setPendingQuestion(sessionKey, {
        questions,
        sessionId: result.sessionId || pending.sessionId,
        model: pending.model || session.model,
        chatId: ctx.chatId || pending.chatId,
        chatType: ctx.chatType || pending.chatType,
        openId: ctx.openId || pending.openId,
        userId: pending.userId,
        messageId: ctx.messageId || pending.messageId,
        cardMessageId: cardMsgId,
      })
      if (ctx.messageId && reactionId) {
        await messageSender.replaceReaction(ctx.messageId, reactionId, 'THUMBSUP').catch(() => {})
      }
      return
    }

    if (result.aborted) {
      sessionManager.cancelProcessing(sessionKey, msgIndex)
      if (ctx.messageId && reactionId) {
        await messageSender.replaceReaction(ctx.messageId, reactionId, 'HEART').catch(() => {})
      }
      return
    }

    // 正常完成 — 先修复冗余回复再 finishProcessing
    let replyText = fixTruncatedReply(result.result, result.steps, '[msg] resume:')

    // 长 plan 兜底：plan>1000 字时 resume Claude 建飞书文档
    const archived = await maybeArchiveLongPlan(result, {
      session, sessionKey, msgIndex,
      messageId: ctx.messageId, chatId: ctx.chatId, chatType: ctx.chatType,
      openId: ctx.openId, userId: ctx.userId || '',
      logPrefix: '[msg:resume:plan]',
    })
    if (archived?.aborted) {
      // archive 期间用户撤回卡片消息：走撤回退出
      sessionManager.cancelProcessing(sessionKey, msgIndex)
      if (ctx.messageId && reactionId) {
        await messageSender.replaceReaction(ctx.messageId, reactionId, 'HEART').catch(() => {})
      }
      return
    }
    if (archived) {
      replyText = archived.result
      result.usage = archived.usage || result.usage
      result.lastTurnUsage = archived.lastTurnUsage || result.lastTurnUsage
      result.costUsd = (result.costUsd || 0) + (archived.costUsd || 0)
      result.sessionId = archived.sessionId || result.sessionId
    }

    sessionManager.finishProcessing(sessionKey, replyText, msgIndex)
    sessionManager.updateSession(sessionKey, {
      sessionId: result.sessionId,
      usage: result.usage,
      lastTurnUsage: result.lastTurnUsage,
      costUsd: result.costUsd,
    })
    if (!replyText || !replyText.trim()) {
      replyText = '处理完成，但未生成有效回复内容。请尝试重新描述你的需求，或使用 /new 重置会话后重试。'
    }
    replyText += buildContextFooter(result)
    replyText = truncateForFeishu(replyText)

    await sendReply(replyText)
    if (ctx.messageId && reactionId) {
      await messageSender.replaceReaction(ctx.messageId, reactionId, 'DONE').catch(() => {})
    }
  } catch (err) {
    const errDetail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : ''
    console.error(`[msg] AskUserQuestion resume error: ${err.message}`, errDetail)
    if (ctx.messageId) activeProcessing.delete(ctx.messageId)
    sessionManager.cancelProcessing(sessionKey, msgIndex)
    const errMsg = `处理出错：${err.message.slice(0, 200)}\n\n请稍后重试，或使用 /new 重置会话。`
    await sendReply(errMsg).catch(() => {})
    if (ctx.messageId && reactionId) {
      await messageSender.replaceReaction(ctx.messageId, reactionId, 'HEART').catch(() => {})
    }
  }
}

// --- 卡片按钮点击处理（card.action.trigger 事件）---

/**
 * 卡片按钮点击处理（card.action.trigger 事件）
 * 通过 patchCard API 主动更新卡片（WS 模式下 EventDispatcher 的返回值不会更新卡片，需用 CardActionHandler 才行）
 */
function handleCardAction(data) {
  const action = data.action || {}
  const value = action.value || {}

  // AskUserQuestion 权限卡片：选项按钮
  if (value.permToken && value.permKind === 'answer') {
    const { permToken, qi, idx } = value
    console.log(`[card-action] 选题: token=${permToken} qi=${qi} idx=${idx}`)
    permissionQuestionCard.applyQuestionAnswer(permToken, qi || 0, idx, 'feishu').catch(err => {
      console.error('[card-action] 选题回调失败:', err.message)
    })
    return
  }

  // AskUserQuestion 元操作：Chat about this / Skip interview 等
  if (value.permToken && value.permKind === 'meta' && value.answerLabel) {
    const { permToken, answerLabel } = value
    console.log(`[card-action] 元操作: token=${permToken} label=${answerLabel}`)
    permissionQuestionCard.applyMetaAction(permToken, answerLabel, 'feishu').catch(err => {
      console.error('[card-action] 元操作回调失败:', err.message)
    })
    return
  }

  // 权限卡片回调（批准/拒绝，来自 Claude Code PermissionRequest hook）
  if (value.permToken && value.action) {
    const { permToken, action: decision } = value
    console.log(`[card-action] 权限决定: token=${permToken} decision=${decision}`)
    const payload = permissionCard.loadCardMeta(permToken)
    if (!payload || payload.type === 'ask_user') {
      console.warn(`[card-action] 跳过批准/拒绝: token=${permToken} 非 Bash 权限卡（请点选项按钮）`)
      return
    }
    permissionCard.writeResult(permToken, decision)
    const cardMessageId = data.context?.open_message_id || payload.messageId
    permissionCard.clearPayload(permToken)
    if (cardMessageId) {
      messageSender.patchCard(cardMessageId, permissionCard.buildDecidedCard(decision, { ...payload, source: 'feishu' })).catch(err => {
        console.error('[card-action] 更新权限卡片失败:', err.message)
      })
    }
    return
  }

  const { sk: sessionKey, qi: questionIndex, idx: optionIndex } = value

  if (!sessionKey || optionIndex == null) {
    console.log('[card-action] 无效的 action value，跳过')
    return
  }

  const cardMessageId = data.context?.open_message_id
  const peek = interactionManager.getPendingQuestion(sessionKey)
  if (!peek) {
    console.log(`[card-action] 无 pending question: ${sessionKey}（可能已被文字回复消费或过期）`)
    const expiredTip = messageSender.textContent('⏰ 此交互卡片已过期或已被回复，请直接发消息继续对话')
    if (cardMessageId) {
      messageSender.replyMessage(cardMessageId, expiredTip).catch(() => {})
    } else if (data.context?.open_chat_id) {
      messageSender.sendMessage('chat_id', data.context.open_chat_id, expiredTip).catch(() => {})
    }
    return
  }

  const questions = peek.questions || []
  const qi = questionIndex || 0
  const q = questions[qi]
  const opt = (q?.options || [])[optionIndex]
  const answerText = opt ? opt.label : String(optionIndex + 1)

  // 单问题：直接消费并 resume
  if (questions.length <= 1) {
    const pending = interactionManager.consumePendingQuestion(sessionKey)
    if (!pending) return

    console.log(`[card-action] 按钮点击: sessionKey=${sessionKey} answer="${answerText}"`)

    if (cardMessageId) {
      messageSender.patchCard(cardMessageId, messageSender.buildAnsweredCard(questions, qi, optionIndex)).catch(err => {
        console.error('[card-action] 更新卡片失败:', err.message)
      })
    }

    const chatId = pending.chatId || data.context?.open_chat_id
    const chatType = pending.chatType || 'p2p'
    const openId = data.operator?.open_id || ''
    executeQuestionAnswer(sessionKey, answerText, pending, { messageId: pending.messageId, chatId, chatType, openId }).catch(err => {
      console.error('[card-action] resume error:', err.message)
    })
    return
  }

  // 多问题：记录部分回答
  const result = interactionManager.answerQuestion(sessionKey, qi, optionIndex)
  if (!result) return

  console.log(`[card-action] 按钮点击(${Object.keys(result.answers).length}/${questions.length}): sessionKey=${sessionKey} answer="${answerText}"`)

  if (result.allAnswered) {
    // 全部已答 — 消费并 resume
    const pending = interactionManager.consumePendingQuestion(sessionKey)
    if (!pending) return
    pending.buttonAnswers = result.answers

    if (cardMessageId) {
      messageSender.patchCard(cardMessageId, messageSender.buildAllAnsweredCard(questions, result.answers)).catch(err => {
        console.error('[card-action] 更新卡片失败:', err.message)
      })
    }

    // 组合所有回答
    const answerParts = []
    for (let i = 0; i < questions.length; i++) {
      const selectedOpt = (questions[i].options || [])[result.answers[i]]
      answerParts.push(selectedOpt ? selectedOpt.label : String(result.answers[i] + 1))
    }

    const chatId = pending.chatId || data.context?.open_chat_id
    const chatType = pending.chatType || 'p2p'
    const openId = data.operator?.open_id || ''
    executeQuestionAnswer(sessionKey, answerParts.join(', '), pending, { messageId: pending.messageId, chatId, chatType, openId }).catch(err => {
      console.error('[card-action] resume error:', err.message)
    })
  } else {
    // 部分已答 — 更新卡片显示进度
    if (cardMessageId) {
      messageSender.patchCard(cardMessageId, messageSender.buildPartialAnsweredCard(questions, result.answers, sessionKey)).catch(err => {
        console.error('[card-action] 更新卡片失败:', err.message)
      })
    }
  }
}

// --- Cron 定时任务执行回调 ---

async function executeCronJob(job) {
  const { id, prompt, chatId, userId } = job
  // cron 用 sendMessage 直发群，不走话题；强制 chat: 会话独立于用户在群里的对话
  const sessionKey = sessionManager.makeKey('group', chatId, '', userId, '', { isSoloGroup: true })
  try {
    const session = sessionManager.getOrCreateSession(sessionKey)

    // 记录任务开始（web 后台可见）
    sessionManager.startProcessing(sessionKey, `⏰ 定时任务 #${id}: ${prompt}`)

    // 定时任务使用临时会话：不传 sessionId，每次都是全新 Claude 会话，避免上下文无限膨胀
    // disableInteraction: 禁止 AskUserQuestion/EnterPlanMode，定时任务无人交互
    const { promise } = claudeBridge.callClaude(prompt, {
      model: session.model,
      sessionKey,
      disableInteraction: true,
      onStep: (step) => sessionManager.appendStep(sessionKey, step),
    })
    const result = await promise

    // 定时任务不支持交互：如果 Claude 触发了 AskUserQuestion，直接跳过
    if (result.aborted && result.askUserQuestion) {
      console.log(`[cron] Job #${id} 触发了 AskUserQuestion，定时任务不支持交互，跳过`)
      sessionManager.finishProcessing(sessionKey, '[定时任务不支持交互确认]')
      await messageSender.sendMessage('chat_id', chatId,
        messageSender.textContent(`⏰ 定时任务 #${id} 需要交互确认但定时任务不支持，请手动执行：${prompt.slice(0, 100)}`))
      return
    }

    // 记录最终结果
    sessionManager.finishProcessing(sessionKey, result.result)

    // 不保存 sessionId，下次执行仍然是新会话
    sessionManager.updateSession(sessionKey, {
      usage: result.usage,
      lastTurnUsage: result.lastTurnUsage,
      costUsd: result.costUsd,
    })

    // 防护：Claude 可能在群通知后输出多余总结/确认文字，导致 result 不是真正的通知内容
    // 判断条件：result 过短 或 不含中文（正常报告一定有中文），则回退到倒数第 2 个 text step
    let sentText = result.result
    const textSteps = (result.steps || []).filter(s => s.type === 'text')
    const hasChinese = /[\u4e00-\u9fff]/.test(sentText)
    if ((!hasChinese || sentText.length < 100) && textSteps.length >= 2) {
      const secondLast = textSteps[textSteps.length - 2]
      const secondLastText = secondLast.fullText || secondLast.content || ''
      if (secondLastText.length > sentText.length) {
        console.log(`[cron] Job #${id} result 疑似非通知内容(${sentText.length}字, hasChinese=${hasChinese}), 使用倒数第2个 text step(${secondLastText.length}字) 替代`)
        sentText = secondLastText
      }
    }
    // 解析附件协议（定时任务可能产出图片/文件）
    const { text: cronClean, attachments: cronAtts } = parseAttachments(sentText)
    if (cronClean || !cronAtts.length) {
      const { content: cronFormatted, msgType: cronMsgType } = markdownToCard.formatReply(cronClean || sentText, { isGroup: true })
      await messageSender.sendMessage('chat_id', chatId, cronFormatted, cronMsgType)
    }
    for (const att of cronAtts) {
      try {
        if (att.type === 'file') await messageSender.sendFile(chatId, att.path)
        else if (att.type === 'image') await messageSender.sendImage(chatId, att.path)
      } catch (e) { console.error(`[cron attach] ${att.type} ${att.path}: ${e.message}`) }
    }

    // 记录实际发送的消息（web 后台可见）
    sessionManager.addMessage(sessionKey, 'sent', sentText)
  } catch (err) {
    console.error(`[cron] Job #${id} error:`, err.message)
    sessionManager.cancelProcessing(sessionKey)
    await messageSender.sendMessage('chat_id', chatId,
      messageSender.textContent(`⏰ 定时任务 #${id} 执行失败：${err.message.slice(0, 200)}`))
      .catch(() => {})
  }
}

// --- 消息撤回处理 ---

function handleMessageRecalled(data) {
  console.log(`[recall] 收到撤回事件:`, JSON.stringify(data).slice(0, 500))

  // 飞书 recalled 事件 message_id 可能在顶层或嵌套在 message 中
  const messageId = data.message_id || data.message?.message_id
  if (!messageId) {
    console.log(`[recall] 无法提取 message_id，跳过`)
    return
  }

  const active = activeProcessing.get(messageId)
  if (active) {
    console.log(`[recall] 消息 ${messageId} 正在处理中，终止 Claude`)
    active.abort()
  } else {
    console.log(`[recall] 消息 ${messageId} 不在活跃处理中 (当前活跃: ${[...activeProcessing.keys()].join(', ') || '无'})`)
  }
}

// --- cron 初始化（由 server.js 显式调用，避免 require 时自动启动调度）---

function initCronJobs() {
  cronManager.loadJobs(executeCronJob)
}

// --- 重启恢复：保存活跃任务 / 终止所有进程 / 恢复中断任务 ---

/**
 * 将当前活跃任务持久化到磁盘（SIGTERM 时调用，同步写入）
 */
function saveActiveTasks() {
  const tasks = []
  for (const [messageId, task] of activeProcessing) {
    const session = sessionManager.getSession(task.sessionKey)
    if (!session || !session.sessionId) continue
    tasks.push({
      messageId: task.messageId || messageId,
      sessionKey: task.sessionKey,
      msgIndex: task.msgIndex,
      chatId: task.chatId,
      chatType: task.chatType,
      openId: task.openId,
      userId: task.userId,
      sessionId: session.sessionId,
      model: session.model,
    })
  }
  if (tasks.length === 0) {
    try { fs.unlinkSync(ACTIVE_TASKS_FILE) } catch {}
    return
  }
  try {
    fs.writeFileSync(ACTIVE_TASKS_FILE, JSON.stringify({ savedAt: Date.now(), tasks }), 'utf8')
    console.log(`[webhook] 已保存 ${tasks.length} 个活跃任务供重启后恢复`)
  } catch (err) {
    console.error('[webhook] 保存活跃任务失败:', err.message)
  }
}

/**
 * 终止所有活跃的 Claude 进程
 */
function abortAllActive() {
  for (const [messageId, task] of activeProcessing) {
    try { task.abort() } catch {}
  }
}

/**
 * 重启后恢复中断的任务
 */
const ACTIVE_TASKS_MAX_AGE = 5 * 60 * 1000 // 5 分钟内的任务才恢复

async function resumeInterruptedTasks() {
  let tasks
  try {
    if (!fs.existsSync(ACTIVE_TASKS_FILE)) return
    const raw = JSON.parse(fs.readFileSync(ACTIVE_TASKS_FILE, 'utf8'))
    fs.unlinkSync(ACTIVE_TASKS_FILE)

    // 兼容新旧格式：新格式 { savedAt, tasks }，旧格式直接是数组
    const savedAt = raw.savedAt || 0
    tasks = raw.tasks || (Array.isArray(raw) ? raw : null)

    if (savedAt && Date.now() - savedAt > ACTIVE_TASKS_MAX_AGE) {
      console.log(`[webhook] 活跃任务文件已过期（${Math.round((Date.now() - savedAt) / 1000)}s ago），跳过恢复`)
      return
    }
  } catch (err) {
    console.error('[webhook] 读取活跃任务文件失败:', err.message)
    return
  }

  if (!tasks || tasks.length === 0) return
  console.log(`[webhook] 发现 ${tasks.length} 个被中断的任务，开始恢复`)

  for (const task of tasks) {
    resumeSingleTask(task).catch(err => {
      console.error(`[webhook] 恢复任务失败 (${task.sessionKey}):`, err.message)
    })
  }
}

async function resumeSingleTask(task) {
  console.log(`[resume] 恢复任务: sessionKey=${task.sessionKey} sessionId=${task.sessionId}`)

  const session = sessionManager.getOrCreateSession(task.sessionKey)

  // 更新中断消息
  if (task.msgIndex >= 0) {
    sessionManager.updateMessageText(task.sessionKey, task.msgIndex, '[服务重启，正在恢复任务...]')
  }

  // 新建 processing 条目
  const msgIndex = sessionManager.startProcessing(task.sessionKey, '[服务重启自动恢复]')

  const resumePrompt = '[系统消息：服务因维护重启，请继续执行之前被中断的任务。如果之前的任务已经完成，请直接输出结果。]'

  try {
    const { promise, abort, sessionId: claudeSessionId } = claudeBridge.callClaude(resumePrompt, {
      sessionId: task.sessionId,
      model: task.model,
      sessionKey: task.sessionKey,
      onStep: (step) => sessionManager.appendStep(task.sessionKey, step, msgIndex),
    })
    // 将 resume 任务也纳入 activeProcessing，确保再次重启时可被保存
    const resumeTrackingKey = `resume:${task.messageId}`
    activeProcessing.set(resumeTrackingKey, {
      abort, sessionKey: task.sessionKey, msgIndex, messageId: task.messageId,
      chatId: task.chatId, chatType: task.chatType, openId: task.openId, userId: task.userId,
    })

    const result = await promise
    activeProcessing.delete(resumeTrackingKey)
    resourceDownloader.ingestSessionRegistrations(task.sessionKey)

    // AskUserQuestion 触发 → 正常发卡片
    if (result.aborted && result.askUserQuestion) {
      let questions = result.askUserQuestion.questions || []
      if (!Array.isArray(questions) || questions.length === 0) {
        console.warn(`[resume] AskUserQuestion 格式异常，跳过。raw: ${JSON.stringify(result.askUserQuestion).slice(0, 200)}`)
        sessionManager.cancelProcessing(task.sessionKey, msgIndex)
        await sendToUser(task,
          messageSender.textContent('服务重启后恢复任务时，Claude 请求确认但问题格式异常，请重新发送消息或使用 /new 重置会话。'),
          'text').catch(() => {})
        return
      }
      if (questions.length > 4) questions = questions.slice(0, 4)
      console.log(`[resume] 恢复过程中触发 AskUserQuestion，发送卡片`)

      if (result.sessionId) {
        sessionManager.updateSession(task.sessionKey, { sessionId: result.sessionId })
      }
      sessionManager.finishProcessing(task.sessionKey, '[等待用户确认...]', msgIndex)

      const card = messageSender.buildQuestionCard(questions, task.sessionKey)
      const cardRes = await sendToUser(task, JSON.stringify(card), 'interactive')
      const cardMsgId = cardRes?.data?.message_id

      interactionManager.setPendingQuestion(task.sessionKey, {
        questions,
        sessionId: result.sessionId || task.sessionId,
        model: task.model,
        chatId: task.chatId,
        chatType: task.chatType,
        openId: task.openId,
        userId: task.userId,
        messageId: task.messageId,
        cardMessageId: cardMsgId,
      })
      return
    }

    if (result.aborted) {
      console.log(`[resume] 恢复任务被中断: sessionKey=${task.sessionKey}`)
      sessionManager.cancelProcessing(task.sessionKey, msgIndex)
      await sendToUser(task,
        messageSender.textContent('服务重启后恢复任务已被中断，请重新发送消息继续。'),
        'text').catch(() => {})
      return
    }

    // 正常完成
    let replyText = fixTruncatedReply(result.result, result.steps, '[resume]')

    // 长 plan 兜底：plan>1000 字时 resume Claude 建飞书文档
    const archived = await maybeArchiveLongPlan(result, {
      session: { model: task.model }, sessionKey: task.sessionKey, msgIndex,
      messageId: task.messageId, chatId: task.chatId, chatType: task.chatType,
      openId: task.openId, userId: task.userId,
      logPrefix: '[resume:plan]',
    })
    if (archived?.aborted) {
      // archive 期间任务被中断：走中断退出，与原 result.aborted 路径一致
      console.log(`[resume] 长 plan archive 被中断: sessionKey=${task.sessionKey}`)
      sessionManager.cancelProcessing(task.sessionKey, msgIndex)
      await sendToUser(task,
        messageSender.textContent('服务重启后恢复任务已被中断，请重新发送消息继续。'),
        'text').catch(() => {})
      return
    }
    if (archived) {
      replyText = archived.result
      result.usage = archived.usage || result.usage
      result.lastTurnUsage = archived.lastTurnUsage || result.lastTurnUsage
      result.costUsd = (result.costUsd || 0) + (archived.costUsd || 0)
      result.sessionId = archived.sessionId || result.sessionId
    }

    sessionManager.finishProcessing(task.sessionKey, replyText, msgIndex)
    sessionManager.updateSession(task.sessionKey, {
      sessionId: result.sessionId,
      usage: result.usage,
      lastTurnUsage: result.lastTurnUsage,
      costUsd: result.costUsd,
    })
    if (!replyText || !replyText.trim()) return

    replyText += buildContextFooter(result)

    // 解析附件协议
    const { text: resumeClean, attachments: resumeAtts } = parseAttachments(replyText)
    if (resumeClean || !resumeAtts.length) {
      const { content, msgType } = markdownToCard.formatReply(resumeClean || replyText, {
        openId: task.openId, userId: task.userId, isGroup: task.chatType === 'group',
      })
      await sendToUser(task, content, msgType)
    }
    // 附件走 reply 路径，让附件落到原消息所在话题；reply 失败时 fallback 到 chatId 直发（与 sendToUser 行为对称）
    const resumeOpts = task.messageId ? await getReplyOpts(task.chatType, task.chatId).catch(() => null) : null
    const resumeAttachOpts = task.messageId ? { replyToMessageId: task.messageId, ...(resumeOpts || {}) } : {}
    for (const att of resumeAtts) {
      try {
        const chatId = task.chatId
        if (att.type === 'file') {
          await messageSender.sendFile(chatId, att.path, resumeAttachOpts)
            .catch(() => messageSender.sendFile(chatId, att.path))
        } else if (att.type === 'image') {
          await messageSender.sendImage(chatId, att.path, resumeAttachOpts)
            .catch(() => messageSender.sendImage(chatId, att.path))
        }
      } catch (e) { console.error(`[resume attach] ${att.type} ${att.path}: ${e.message}`) }
    }
    console.log(`[resume] 任务恢复完成: sessionKey=${task.sessionKey}`)
  } catch (err) {
    console.error(`[resume] 任务恢复出错 (${task.sessionKey}):`, err.message)
    sessionManager.cancelProcessing(task.sessionKey, msgIndex)
    await sendToUser(task,
      messageSender.textContent(`服务重启后恢复任务失败：${err.message.slice(0, 200)}\n请重新发送消息。`),
      'text').catch(() => {})
  }
}

/**
 * 发送消息给用户：优先回复原消息，失败则 fallback 到 chatId 直发
 */
async function sendToUser(task, content, msgType) {
  try {
    const opts = await getReplyOpts(task.chatType, task.chatId)
    return await messageSender.replyMessage(task.messageId, content, msgType, opts)
  } catch {
    return await messageSender.sendMessage('chat_id', task.chatId, content, msgType)
  }
}

module.exports = { handleMessageEvent, handleMessageRecalled, handleCardAction, isDuplicate, executeCronJob, initCronJobs, saveActiveTasks, abortAllActive, resumeInterruptedTasks }
