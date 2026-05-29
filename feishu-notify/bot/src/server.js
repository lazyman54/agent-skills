'use strict'

const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const lark = require('@larksuiteoapi/node-sdk')
const config = require('../config.json')

// --- 启动时自举 ft-lark-cli 环境（异步不阻塞）---
// 检测并安装 @futu/ft-lark-cli + 写入凭证。失败时通过飞书 IM 通知管理员
const bootstrapScript = path.resolve(__dirname, '../scripts/lark-bootstrap.sh')
setImmediate(() => {
  const proc = spawn('bash', [bootstrapScript], { stdio: 'inherit' })
  proc.on('close', (code) => {
    if (code !== 0) console.warn(`[server] lark-bootstrap 退出码 ${code}（不影响服务启动）`)
  })
  proc.on('error', (err) => console.warn(`[server] lark-bootstrap 启动失败: ${err.message}`))
})
const { handleMessageEvent, handleMessageRecalled, handleCardAction, initCronJobs, saveActiveTasks, abortAllActive, resumeInterruptedTasks } = require('./feishu/webhook-handler')
const { initSessionManager, saveToDisk: saveSessionsToDisk } = require('./session/manager')
const { initResourceManager, saveToDisk: saveResourcesToDisk } = require('./feishu/resource-downloader')
const { handleAdminRequest } = require('./admin/router')
const permissionCard = require('./feishu/permission-card')
const permissionQuestionCard = require('./feishu/permission-question-card')
const crypto = require('crypto')

function buildStopCard({ title, template, content }) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { content: title, tag: 'plain_text' }, template },
    body: { elements: [{ tag: 'markdown', content }] },
  }
}

function buildTaskCard({ task_id, task_subject, task_description, project }) {
  const lines = [`**任务**: #${task_id} ${task_subject}`]
  if (project) lines.push(`**项目**: ${project}`)
  if (task_description) lines.push(`**描述**: ${task_description.slice(0, 100)}${task_description.length > 100 ? '…' : ''}`)
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { content: '✅ 任务完成', tag: 'plain_text' }, template: 'green' },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}
const { cleanupAll: cleanupAllResources } = require('./session-resources')
const messageSender = require('./feishu/message-sender')

// 启动后异步拉一次 bot open_id 缓存（用于群聊 @机器人 判断）
setImmediate(() => { messageSender.fetchBotOpenId() })

const PORT = config.port || 18080

// --- 1. 飞书 WSClient 长连接 ---

const wsClient = new lark.WSClient({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.debug,
})

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({
    loggerLevel: lark.LoggerLevel.debug,
  }).register({
    'im.message.receive_v1': async (data) => {
      await handleMessageEvent(data)
    },
    'im.message.recalled_v1': async (data) => {
      handleMessageRecalled(data)
    },
    'card.action.trigger': async (data) => {
      console.log(`[card-action] RAW: ${JSON.stringify(data).slice(0, 500)}`)
      return handleCardAction(data)
    },
  }),
})

console.log('[server] Feishu WSClient started (long connection mode)')

// --- 1b. WS 连接健康监控 ---
// 飞书 SDK 的 WSClient.connect() 没有超时机制，WS 握手挂起时
// 重连链路会永久卡死（isConnecting=true 不释放）。
// 这里加一个定时看门狗，检测到卡死后强制重连。

const WS_CHECK_INTERVAL = 60 * 1000     // 每 60 秒检查
const WS_STUCK_THRESHOLD = 180 * 1000   // 3 分钟无法恢复视为卡死

let wsUnhealthySince = 0

setInterval(() => {
  const wsInstance = wsClient.wsConfig.getWSInstance()
  const isOpen = wsInstance && wsInstance.readyState === 1 // WebSocket.OPEN

  if (isOpen) {
    if (wsUnhealthySince > 0) {
      console.log('[ws-monitor] WS 连接已恢复')
    }
    wsUnhealthySince = 0
    return
  }

  // WS 不在 OPEN 状态
  if (wsUnhealthySince === 0) {
    wsUnhealthySince = Date.now()
    console.log('[ws-monitor] WS 连接不健康，开始监控')
    return
  }

  const stuckMs = Date.now() - wsUnhealthySince
  if (stuckMs < WS_STUCK_THRESHOLD) {
    console.log(`[ws-monitor] WS 断开 ${Math.round(stuckMs / 1000)}s，等待 SDK 自动重连...`)
    return
  }

  // 超时，强制重连
  console.error(`[ws-monitor] WS 已断开 ${Math.round(stuckMs / 1000)}s，强制重连`)
  wsUnhealthySince = Date.now() // 重置计时，避免下一轮立即再触发

  // 清除 SDK 内部卡死状态
  wsClient.isConnecting = false
  if (wsClient.reconnectInterval) {
    clearTimeout(wsClient.reconnectInterval)
    wsClient.reconnectInterval = undefined
  }

  // isStart=true 走 finally 路径，保证 isConnecting 被清理
  wsClient.reConnect(true).catch(err => {
    console.error('[ws-monitor] 强制重连失败:', err.message)
  })
}, WS_CHECK_INTERVAL)

// --- 2. HTTP 服务（健康检查）---

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0]

  // Admin 路由
  if (url.startsWith('/admin')) {
    handleAdminRequest(req, res)
    return
  }

  res.setHeader('Content-Type', 'application/json')

  // Hook 调用：发送权限请求卡片
  if (req.method === 'POST' && url === '/permission-request') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { tool_name: toolName, command, project } = JSON.parse(body)
        const { receiveIdType, receiveId } = config.targets || {}
        const chatId = config.group?.chatId
        // 优先发到群（用户常在群里看）；无群时再发私聊
        const targetType = chatId ? 'chat_id' : receiveIdType
        const targetId = chatId || receiveId
        if (!targetId) {
          res.writeHead(503)
          res.end(JSON.stringify({ error: 'targets.receiveId or group.chatId required' }))
          return
        }
        const token = crypto.randomUUID().replace(/-/g, '')
        const { messageId } = await permissionCard.sendPermissionCard(
          targetType, targetId, token, { toolName, command, project },
        )
        res.writeHead(200)
        res.end(JSON.stringify({ token, messageId }))
      } catch (err) {
        console.error('[permission-request] error:', err.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // AskUserQuestion：发送带选项按钮的问题卡片（Claude Code PermissionRequest）
  if (req.method === 'POST' && url === '/ask-user-request') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { project, questions } = JSON.parse(body)
        const { receiveIdType, receiveId } = config.targets || {}
        const chatId = config.group?.chatId
        const targetType = receiveId ? receiveIdType : 'chat_id'
        const targetId = receiveId || chatId
        if (!targetId) {
          res.writeHead(503)
          res.end(JSON.stringify({ error: 'targets not configured' }))
          return
        }
        if (!Array.isArray(questions) || questions.length === 0) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'questions array required' }))
          return
        }
        const token = crypto.randomUUID().replace(/-/g, '')
        const { messageId } = await permissionQuestionCard.sendPermissionQuestionCard(
          targetType, targetId, token, { project, questions },
        )
        res.writeHead(200)
        res.end(JSON.stringify({ token, messageId }))
      } catch (err) {
        console.error('[ask-user-request] error:', err.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // AskUserQuestion：仅提醒，需在 Claude Code 终端选题（无批准/拒绝按钮）
  if (req.method === 'POST' && url === '/ask-user-notify') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { tool_name: toolName, project, content } = JSON.parse(body)
        const chatId = config.group?.chatId
        if (!chatId) { res.writeHead(503); res.end('{}'); return }
        const card = {
          schema: '2.0',
          config: { wide_screen_mode: true },
          header: { title: { content: '💬 Claude 等你作答', tag: 'plain_text' }, template: 'blue' },
          body: {
            elements: [{
              tag: 'markdown',
              content: [`**工具**: ${toolName || 'AskUserQuestion'}`, `**项目**: ${project || '-'}`, '', content || ''].join('\n'),
            }],
          },
        }
        await messageSender.sendMessage('chat_id', chatId, JSON.stringify(card), 'interactive')
        res.writeHead(200); res.end('{}')
      } catch (err) {
        console.error('[ask-user-notify] error:', err.message)
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // 通用提醒卡片（Notification hook：permission_prompt / idle_prompt）
  if (req.method === 'POST' && url === '/notify-card') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { title, template, content } = JSON.parse(body)
        const chatId = config.group?.chatId
        if (!chatId) { res.writeHead(503); res.end('{}'); return }
        const card = buildStopCard({
          title: title || 'Claude 通知',
          template: template || 'blue',
          content: content || '',
        })
        await messageSender.sendMessage('chat_id', chatId, JSON.stringify(card), 'interactive')
        res.writeHead(200); res.end('{}')
      } catch (err) {
        console.error('[notify-card] error:', err.message)
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // Stop hook 通知
  if (req.method === 'POST' && url === '/stop-notify') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body)
        const chatId = config.group?.chatId
        if (!chatId) { res.writeHead(503); res.end('{}'); return }
        await messageSender.sendMessage('chat_id', chatId, JSON.stringify(buildStopCard(payload)), 'interactive')
        res.writeHead(200); res.end('{}')
      } catch (err) {
        console.error('[stop-notify] error:', err.message)
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // StopFailure hook 通知（异常中断）
  if (req.method === 'POST' && url === '/stop-failure') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { reason, project } = JSON.parse(body)
        const chatId = config.group?.chatId
        if (!chatId) { res.writeHead(503); res.end('{}'); return }
        const card = {
          schema: '2.0',
          config: { wide_screen_mode: true },
          header: { title: { content: '❌ Claude 异常中断', tag: 'plain_text' }, template: 'red' },
          body: { elements: [{ tag: 'markdown', content: [`**项目**: ${project || '-'}`, `**原因**: ${reason || '未知'}`, `**时间**: ${new Date().toLocaleTimeString('zh-CN')}`].join('\n') }] },
        }
        await messageSender.sendMessage('chat_id', chatId, JSON.stringify(card), 'interactive')
        res.writeHead(200); res.end('{}')
      } catch (err) {
        console.error('[stop-failure] error:', err.message)
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // TaskCompleted hook 通知
  if (req.method === 'POST' && url === '/task-completed') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body)
        const chatId = config.group?.chatId
        if (!chatId) { res.writeHead(503); res.end('{}'); return }
        await messageSender.sendMessage('chat_id', chatId, JSON.stringify(buildTaskCard(payload)), 'interactive')
        res.writeHead(200); res.end('{}')
      } catch (err) {
        console.error('[task-completed] error:', err.message)
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // AskUserQuestion：终端选题后同步飞书卡片（PostToolUse → Python hook）
  if (req.method === 'POST' && url === '/question-synced') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { token, updatedInput, source } = JSON.parse(body)
        if (!token) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'token required' }))
          return
        }
        const result = await permissionQuestionCard.syncQuestionFromTerminal(
          token,
          updatedInput || {},
          source || 'claude_terminal',
        )
        res.writeHead(result.ok ? 200 : 404)
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('[question-synced] error:', err.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // Hook / 终端同步决策：更新飞书卡片（Claude 终端批准、feishu-approve 等）
  if (req.method === 'POST' && url === '/decision') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { token, decision, source } = JSON.parse(body)
        if (!token || !decision) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'token and decision required' }))
          return
        }
        const result = await permissionCard.applyExternalDecision(token, decision, source || 'terminal')
        res.writeHead(result.ok ? 200 : 404)
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('[decision] error:', err.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  // 权限请求超时 @提醒（2分钟无响应后触发）
  if (req.method === 'POST' && url === '/ding') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { token, project, command } = JSON.parse(body)
        const chatId = config.group?.chatId
        const openId = config.targets?.receiveId
        if (!chatId) { res.writeHead(503); res.end('{}'); return }
        const content = JSON.stringify({
          zh_cn: {
            title: '⏰ 权限请求等待超过2分钟',
            content: [[
              { tag: 'at', user_id: openId },
              { tag: 'text', text: ` 项目: ${project || '-'}  命令: ${(command || '').slice(0, 60)}` },
            ]],
          },
        })
        await messageSender.sendMessage('chat_id', chatId, content, 'post')
        res.writeHead(200); res.end('{}')
      } catch (err) {
        console.error('[ding] error:', err.message)
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  if (req.method === 'GET' && url === '/health') {
    const wsInstance = wsClient.wsConfig.getWSInstance()
    const wsState = wsInstance ? wsInstance.readyState : -1
    const wsStateMap = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED', '-1': 'NO_INSTANCE' }
    res.writeHead(200)
    res.end(JSON.stringify({
      status: wsState === 1 ? 'ok' : 'degraded',
      mode: 'ws-long-connection',
      uptime: process.uptime(),
      ws: { state: wsStateMap[wsState] || wsState, unhealthySince: wsUnhealthySince || null },
    }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

httpServer.listen(PORT, () => {
  console.log(`[server] Health check listening on :${PORT}`)
  console.log(`[server] http://localhost:${PORT}/health`)
})

// --- 3. 初始化资源文件管理 + session 持久化 + cron 定时任务 ---
// 注：资源文件必须先于 session 初始化，因为 session loadFromDisk 清理过期会话时
// 需要 resourceDownloader 的 sessionFiles Map 已加载，才能正确删除关联文件
initResourceManager()
initSessionManager()
initCronJobs()

// --- 4. 优雅退出：保存活跃任务 + 会话 → 重启后自动恢复 ---

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received, saving state and shutting down...`)
  saveActiveTasks()      // 持久化正在执行的 Claude 任务（供重启后 resume）
  abortAllActive()       // 终止 Claude 子进程
  cleanupAllResources()  // 清理会话资源（frpc 服务进程 + gitlab 目录占用）
  saveSessionsToDisk()   // 持久化会话
  saveResourcesToDisk()  // 持久化资源文件映射
  process.exit(0)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// --- 5. 重启后恢复被中断的任务（延迟 3s 确保飞书 WS 连接就绪）---
setTimeout(() => {
  resumeInterruptedTasks().catch(err => {
    console.error('[server] 恢复中断任务失败:', err.message)
  })
}, 3000)

// --- 6. 异常兜底 ---

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('[server] Unhandled rejection:', err)
})
