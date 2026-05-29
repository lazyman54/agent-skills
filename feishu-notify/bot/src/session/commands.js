'use strict'

const sessionManager = require('./manager')
const cronManager = require('./cron')
const { isAdmin, checkPermission } = require('../auth/permission')
const config = require('../../config.json')
const interactionManager = require('../feishu/interaction-manager')

/**
 * 检查消息是否为命令，如果是则处理并返回结果
 * @param {string} text - 消息文本
 * @param {string} userId - 用户 ID
 * @param {string} sessionKey - 会话 key
 * @param {object} context - 上下文信息 { chatId, userId, executor }
 * @returns {{handled: boolean, response?: string}} 处理结果
 */
function handleCommand(text, userId, sessionKey, context) {
  // 富文本 @mention 会被渲染成字面量 @botname，剥离首部 @mention 以便命令识别
  const trimmed = text.trim().replace(/^@\S+\s+/, '').trim()

  if (!trimmed.startsWith('/')) {
    return { handled: false }
  }

  const parts = trimmed.split(/\s+/)
  const cmd = parts[0].toLowerCase()

  switch (cmd) {
    case '/new':
      return cmdNew(sessionKey)
    case '/help':
      return cmdHelp(userId)
    case '/status':
      return cmdStatus(sessionKey, userId)
    case '/sonnet':
      return cmdSwitchModel(sessionKey, 'sonnet')
    case '/opus':
      return cmdOpus(sessionKey, userId)
    case '/cron':
      return cmdCron(parts.slice(1), userId, context)
    default:
      return { handled: false }
  }
}

function cmdNew(sessionKey) {
  interactionManager.consumePendingQuestion(sessionKey) // 清除待回答问题
  sessionManager.resetSession(sessionKey)
  return { handled: true, response: '会话已重置。新的对话开始。' }
}

function cmdHelp(userId) {
  const admin = isAdmin(userId)
  let help = `**可用命令：**
- \`/new\` — 重置当前会话
- \`/help\` — 显示帮助信息
- \`/status\` — 当前会话状态
- \`/sonnet\` — 切换到 Sonnet 模型`

  if (admin) {
    help += `
- \`/opus\` — 切换到 Opus 模型（管理员）
- \`/cron <cron表达式> <提示词>\` — 创建定时任务（管理员）
- \`/cron list\` — 列出定时任务（管理员）
- \`/cron del <id>\` — 删除定时任务（管理员）`
  }

  help += `

**支持的能力：**
- 日志查询（FLS）
- 监控查询（Fmonitor）
- 应用信息查询（app-info）
- 代码查看（GitLab）
- MR 代码审查（GitLab）
- 飞书文档操作
- 问题诊断与分析`

  return { handled: true, response: help }
}

function cmdStatus(sessionKey, userId) {
  const session = sessionManager.getSession(sessionKey)
  const admin = isAdmin(userId)

  if (!session) {
    return { handled: true, response: `当前无活跃会话。\n角色：${admin ? '管理员' : '普通用户'}` }
  }

  let status = `**会话状态：**
- 模型：${session.model}
- Token 用量：当前上下文 ${session.usage.contextTokens ?? session.usage.inputTokens} / 累计输出 ${session.usage.outputTokens}
- 费用：$${session.costUsd.toFixed(4)}
- 创建时间：${new Date(session.createdAt).toLocaleString('zh-CN')}
- 会话时长：${Math.round((Date.now() - session.createdAt) / 60000)} 分钟
- 角色：${admin ? '管理员' : '普通用户'}`

  if (admin) {
    const stats = sessionManager.getSessionStats()
    status += `\n- 全局活跃会话数：${stats.activeSessions}`
  }

  return { handled: true, response: status }
}

function cmdSwitchModel(sessionKey, model) {
  const session = sessionManager.getOrCreateSession(sessionKey, model)
  sessionManager.updateSession(sessionKey, { model })
  // 直接修改 session.model（updateSession 已处理）
  return { handled: true, response: `已切换到 **${model}** 模型。` }
}

function cmdOpus(sessionKey, userId) {
  if (!checkPermission(userId, 'opus')) {
    return { handled: true, response: '权限不足：Opus 模型仅管理员可用（成本较高）。' }
  }
  return cmdSwitchModel(sessionKey, 'opus')
}

// --- Cron 定时任务管理 ---

function cmdCron(args, userId, context) {
  if (!checkPermission(userId, 'cron')) {
    return { handled: true, response: '权限不足：定时任务仅管理员可用。' }
  }

  if (args.length === 0) {
    return { handled: true, response: '用法：`/cron <spec> <提示词>` | `/cron list` | `/cron del <id>`\nspec 支持：`5m`, `1h`（简单间隔）或 `"0 9 * * 1-5"`（cron 表达式，需引号包裹）' }
  }

  const sub = args[0].toLowerCase()

  if (sub === 'list') {
    const jobs = cronManager.listJobs()
    if (jobs.length === 0) {
      return { handled: true, response: '当前没有定时任务。' }
    }
    const lines = jobs.map(job => {
      const status = job.running ? ' (执行中)' : ''
      return `- #${job.id} \`${job.spec}\` → ${job.prompt.slice(0, 50)}...${status}`
    })
    return { handled: true, response: `**定时任务列表：**\n${lines.join('\n')}` }
  }

  if (sub === 'del' || sub === 'delete') {
    const id = args[1]
    if (!cronManager.removeJob(id)) {
      return { handled: true, response: `未找到定时任务 #${id}` }
    }
    return { handled: true, response: `已删除定时任务 #${id}` }
  }

  // 创建新定时任务：/cron <spec> <prompt...>
  // spec 可以是简单间隔（5m, 1h）或 cron 表达式
  const rawArgs = args.join(' ')
  let spec, prompt

  // 1. 尝试匹配引号包裹的 cron 表达式（支持中英文引号）
  const quotedMatch = rawArgs.match(/^["'""\u201C\u201D](.+?)["'""\u201C\u201D]\s+(.+)$/)
  if (quotedMatch) {
    spec = quotedMatch[1]
    prompt = quotedMatch[2]
  }
  // 2. 尝试自动检测 cron 表达式（前5个token都像cron字段时）
  else if (args.length >= 6 && isCronField(args[0]) && isCronField(args[1]) &&
           isCronField(args[2]) && isCronField(args[3]) && isCronField(args[4])) {
    spec = args.slice(0, 5).join(' ')
    prompt = args.slice(5).join(' ')
  }
  // 3. 简单间隔：/cron 30m 提示词
  else {
    spec = args[0]
    prompt = args.slice(1).join(' ')
  }

  if (!prompt) {
    return { handled: true, response: '请提供定时任务的提示词。用法：`/cron 30m 检查服务状态`' }
  }

  const { chatId, executor } = context || {}
  if (!chatId || !executor) {
    return { handled: true, response: '内部错误：缺少执行上下文。' }
  }

  const result = cronManager.addJob({ spec, prompt, chatId, userId }, executor)
  if (!result.ok) {
    return { handled: true, response: result.error }
  }

  const job = result.job
  return {
    handled: true,
    response: `已创建定时任务 #${job.id}：\`${job.spec}\` → "${prompt.slice(0, 50)}..."`,
  }
}

/**
 * 判断 token 是否像 cron 字段（*, 数字, 范围, 步长, 列表）
 */
function isCronField(token) {
  return /^(\*|\d+(-\d+)?(\/\d+)?)(,(\d+(-\d+)?(\/\d+)?))*$|^\*\/\d+$/.test(token)
}

module.exports = { handleCommand }
