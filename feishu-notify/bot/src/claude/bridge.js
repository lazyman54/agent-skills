'use strict'

const path = require('path')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')
const config = require('../../config.json')

// 显式允许的工具列表 — 通过 CLI --allowedTools 放行
const ALLOWED_TOOLS = [
  'Bash(git:*)',
  'Bash(cd:*)',
  'Bash(python3:*)',
  'Bash(bash:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(ls:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(curl:*)',
  'Bash(ssh:*)',
  'Bash(lark-cli:*)',
  'Bash(ft-lark-cli:*)',
  'Read',
  'Grep',
  'Glob',
  'Agent',
  'Skill',
  'Write',  // 路径白名单靠 SECURITY_PROMPT 软约束（/tmp/ + .claude/gitlab-projects/），避免走 classifier 模型导致单点不可用
  'Edit',
]

// 硬性禁止的工具列表 — 通过 CLI --disallowedTools 强制生效，无法被 prompt 绕过
const DISALLOWED_TOOLS = [
  'NotebookEdit',
  'TodoWrite',
  'Bash(mv:*)',
  'Bash(cp:*)',
  'Bash(chmod:*)',
  'Bash(chown:*)',
  'Bash(tee:*)',
  'Bash(dd:*)',
  'Bash(mkfs:*)',
  'Bash(kill:*)',
  'Bash(pkill:*)',
  'Bash(killall:*)',
  'Bash(reboot:*)',
  'Bash(shutdown:*)',
  'Bash(systemctl:*)',
  'Bash(npm install:*)',
  'Bash(npm uninstall:*)',
  'Bash(pip install:*)',
  'Bash(pip3 install:*)',
  'Bash(apt:*)',
  'Bash(yum:*)',
  'Bash(node -e:*)',      // 禁止 inline node 脚本（防止调飞书 SDK 产生僵尸进程）
  'Bash(node --eval:*)',  // 同上，长参数形式
  'Bash(node -p:*)',      // 同上，print 形式
  'Bash(node --print:*)', // 同上，长参数 print
]

// 探测 claude CLI 版本，>= 2.1.112 时通过环境变量启用 1M 上下文
// ft-claude-code 在 cli2.js 中默认设置 CLAUDE_CODE_DISABLE_1M_CONTEXT=true
// -enable-1m-ctx flag 实际是在 utils.js 中将该环境变量改为 false 再从 argv 移除
function detectEnable1mCtx() {
  try {
    const out = execFileSync('claude', ['--version'], { timeout: 3000, encoding: 'utf-8' })
    const match = out.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!match) return false
    const [, major, minor, patch] = match.map(Number)
    return major > 2 || (major === 2 && minor > 1) || (major === 2 && minor === 1 && patch >= 112)
  } catch { return false }
}
const enable1mCtx = detectEnable1mCtx()
console.log(`[bridge] 1M 上下文: ${enable1mCtx ? '启用' : '不启用'}`)

// 安全约束系统提示词 — 作为软性补充（防止通过 Bash 间接写文件 / 兜底踩坑约束）
const SECURITY_PROMPT = `
## 语言

始终用中文输出（含 thinking 和最终回复）；技术术语和代码标识符保持原文。

## 安全限制（飞书机器人只读模式）

1. Write/Edit 仅允许写入 /tmp/ 和 .claude/gitlab-projects/(后者 gitlab-dev 用);Bash 间接写文件也遵守此条
2. **禁止用 \`node -e\` / \`node --eval\` / \`node -p\` / \`node --print\` / \`node <<EOF\` / \`bash -c "node -e ..."\` 跑临时脚本验证含飞书 SDK 的模块**——SDK 会建 WebSocket 长连接,事件循环不会清空,进程不退出变僵尸。要测就写独立 \`.js\` 文件,**文件末尾必须含 \`process.exit(0)\`**
3. 例外(允许):运行 .claude/skills/ 下脚本;.claude/gitlab-projects/ 下 git/文件读写;写入 ~/.claude/ 记忆文件;追加 data/gitlab-dev-lessons.md

## 输出格式（飞书消息约束）

1. **最终回复 ≤ 1000 字**(仅指最后一次面向用户的文本回复,不含中间思考/工具)
2. 预判输出超 1000 字 → **必须先用 feishu-project skill 的 archive.js create-doc 创建飞书文档**,完整内容写文档,最终回复给摘要 + 链接
3. **中间 text 输出用户看不到**,只有最终一段发给用户;最终回复必须自包含完整结论,禁止用"如上所述/前面已分析"等引用中间步骤
4. **不要在完整回复后追加简短确认**("已完成""已发送")—— 每段 text 都可能成为发给用户的最终消息
5. **plan mode 下 ExitPlanMode 的 \`plan\` 字段会作为最终回复发给用户**：
   - 短 plan(≤1000 字)直接发卡片;长 plan 服务端会**自动 resume** 让你调 archive.js 建飞书文档,你**不需要**主动判断长度或调 archive.js
   - 写 plan 时**面向用户视角**:**少用 \`## Context\` / \`## Background\` 等文档元章节**(用户已知道自己提的需求);多用决策摘要、关键参数、下一步行动
   - 写到 \`/root/.claude/plans/\` 的本地文件用户看不到——关键内容必须放在 \`plan\` 字段

## 飞书附件协议

发文件/图片给用户时,**禁止**直接调 \`lark-cli im +send-file\` / \`+send-image\` / \`im +messages-send\`(会造成重复回复)。

把文件准备好,在最终 reply 末尾用标记附加:\`[[ATTACH_FILE:/tmp/xxx.csv]]\` / \`[[ATTACH_IMAGE:/tmp/yyy.png]]\`。

服务端(src/feishu/webhook-handler.js)解析标记 → 剥离后发文本 → 逐个发附件。**路径白名单**:只允许 \`/tmp/\` 或 \`data/tmp/\`(子目录也可),其他路径静默丢弃。

## Agent 任务规则

1. **必须等所有 Agent 返回后再输出文本**。Agent 未全部返回时输出任何文本(包括"等 Agent 完成""已启动N个""第X批已完成"等进度宣告)都会提前结束当前轮次,未返回的 Agent 结果丢失
2. **禁止 run_in_background 后结束回复**。后台 Agent 必须同一轮等齐;唯一例外:后续无任何操作依赖该 Agent 的结果(纯记录/统计类),可后台运行且不等待
`

const STEP_CONTENT_LIMIT = 800

function truncate(s, limit) {
  return s.length > limit ? s.slice(0, limit) + '...' : s
}

/**
 * 从单个 stream-json 事件中提取步骤（返回数组，可能 0 或多个）
 */
function extractStepsFromEvent(event) {
  const steps = []

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        steps.push({ type: 'thinking', content: truncate(block.thinking, STEP_CONTENT_LIMIT) })
      } else if (block.type === 'text' && block.text) {
        steps.push({ type: 'text', content: truncate(block.text, STEP_CONTENT_LIMIT), fullText: block.text })
      } else if (block.type === 'tool_use') {
        const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
        steps.push({ type: 'tool_use', tool: block.name || 'unknown', input: truncate(inputStr, STEP_CONTENT_LIMIT) })
      }
    }
  } else if (event.type === 'tool_result') {
    const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content || '')
    steps.push({ type: 'tool_result', content: truncate(content, STEP_CONTENT_LIMIT) })
  }

  return steps
}

/**
 * 调用 Claude CLI 并返回结果
 * @param {string} prompt - 用户输入
 * @param {object} options
 * @param {string} [options.sessionId] - 恢复的会话 ID
 * @param {string} [options.model] - 模型名称（sonnet / opus）
 * @param {function} [options.onStep] - 实时步骤回调 onStep(step)
 * @returns {Promise<{result: string, sessionId: string, usage: object|null, costUsd: number, steps: Array}>}
 */
function callClaude(prompt, options = {}) {
  let proc = null
  let aborted = false

  // 会话 ID 预分配（提到 Promise 外部，供调用方立即获取，用于重启恢复等场景）
  const knownSessionId = options.sessionId || crypto.randomUUID()

  const promise = new Promise((resolve, reject) => {
    // alias → 1M 变体映射：config 写 opus/sonnet 自动切到 [1m] 版本
    // 启用 1M flag 下 alias 只会路由到 200k 版本，必须显式带 [1m] 后缀才能拿到 1M 上下文
    const MODEL_1M_MAP = enable1mCtx ? {
      opus: 'claude-opus-4-7[1m]',
      sonnet: 'claude-sonnet-4-6[1m]',
    } : {}
    const rawModel = options.model || config.claude.model || 'sonnet'
    const model = MODEL_1M_MAP[rawModel] || rawModel
    const timeout = config.claude.timeout || 3600000 // 默认 1 小时
    const workDir = path.resolve(__dirname, '../..')

    const args = [
      ...(enable1mCtx ? ['-enable-1m-ctx'] : []),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--permission-mode', 'auto',
      '--max-budget-usd', '999',
      '--allowedTools', ALLOWED_TOOLS.join(','),
      '--disallowedTools', [
        ...DISALLOWED_TOOLS,
        ...(options.disableInteraction ? ['AskUserQuestion', 'EnterPlanMode'] : []),
      ].join(','),
      '--append-system-prompt', SECURITY_PROMPT,
    ]

    // 会话 ID 管理：resume 已有会话，或为新会话预分配 ID（确保 abort 后仍可 resume）
    if (options.sessionId) {
      args.push('--resume', knownSessionId)
    } else {
      args.push('--session-id', knownSessionId)
    }

    proc = spawn('claude', args, {
      cwd: workDir,
      env: {
        ...process.env,
        LANG: 'en_US.UTF-8',
        // Skills 凭证（从 config.json 读取，脚本已支持这些环境变量）
        ...(config.skills?.flsAuth && { FLS_AUTH: config.skills.flsAuth }),
        ...(config.skills?.flsUser && { FLS_USER: config.skills.flsUser }),
        ...(config.skills?.fmonitorAuth && { FMONITOR_AUTH: config.skills.fmonitorAuth }),
        ...(config.skills?.alertToken && { ALERT_TOKEN: config.skills.alertToken }),
        ...(config.skills?.traceToken && { TRACE_TOKEN: config.skills.traceToken }),
        ...(config.skills?.departmentId && { DEFAULT_DEPARTMENT_ID: String(config.skills.departmentId) }),
        ...(config.skills?.departmentName && { DEFAULT_DEPARTMENT_NAME: config.skills.departmentName }),
        // app-info 多维表格（从 wiki URL 自动解析 app_token + table_id）
        ...(config.skills?.appInfoBitableUrl && { APP_INFO_BITABLE_URL: config.skills.appInfoBitableUrl }),
        ...(config.skills?.externalAppsBitableUrl && { EXTERNAL_APPS_BITABLE_URL: config.skills.externalAppsBitableUrl }),
        // 会话资源追踪（供 skill 脚本注册资源，会话结束时统一清理）
        ...(options.sessionKey && { FEISHU_SESSION_KEY: options.sessionKey }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const allSteps = []
    const onStep = options.onStep || null
    let resultEvent = null
    let askUserData = null // AskUserQuestion 检测
    let exitPlanData = null // ExitPlanMode 检测（plan 字符串，作为最终回复）
    let lastTurnUsage = null // 最近一次 API 调用的 usage（对齐 Claude Code /context）
    let buffer = ''
    let stderr = ''

    function processEvent(event) {
      if (event.type === 'result') {
        resultEvent = event
        return
      }
      const steps = extractStepsFromEvent(event)
      for (const step of steps) {
        allSteps.push(step)
        if (onStep) {
          try { onStep(step) } catch {}
        }
      }

      if (event.type === 'assistant' && event.message?.usage) {
        lastTurnUsage = event.message.usage
      }

      // 检测 AskUserQuestion / ExitPlanMode tool_use
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type !== 'tool_use') continue
          if (!askUserData && block.name === 'AskUserQuestion' && block.input) {
            console.log('[bridge] 检测到 AskUserQuestion，终止 Claude 进程')
            askUserData = block.input
            proc.kill('SIGTERM')
            break
          }
          if (!exitPlanData && block.name === 'ExitPlanMode' && block.input?.plan) {
            // 不 abort：--permission-mode auto 下 CLI 会继续到自然结束，
            // 在 close 处用 plan 覆盖 resultText 即可。abort 反而可能截断 result 事件。
            console.log(`[bridge] 检测到 ExitPlanMode，捕获 plan (${block.input.plan.length} 字符)`)
            exitPlanData = block.input.plan
          }
        }
      }
    }

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          processEvent(JSON.parse(line))
        } catch {}
      }
    })

    proc.stderr.on('data', (data) => { stderr += data.toString() })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => { proc.kill('SIGKILL') }, 5000)
      reject(new Error(`Claude CLI timeout after ${timeout / 1000}s`))
    }, timeout)

    proc.on('close', (code) => {
      clearTimeout(timer)

      // AskUserQuestion 触发的终止 — 返回问题数据供上层发送飞书卡片
      if (askUserData) {
        // 处理 buffer 中可能残留的数据（获取 resultEvent 中的 session_id）
        if (buffer.trim()) {
          try { processEvent(JSON.parse(buffer)) } catch {}
        }
        resolve({
          result: '',
          aborted: true,
          askUserQuestion: askUserData,
          sessionId: resultEvent?.session_id || knownSessionId || '',
          usage: null,
          lastTurnUsage,
          costUsd: 0,
          steps: allSteps,
        })
        return
      }

      // 被主动 abort（撤回消息）时静默 resolve，不报错
      if (aborted) {
        resolve({ result: '', aborted: true, sessionId: '', usage: null, lastTurnUsage, costUsd: 0, steps: allSteps })
        return
      }

      // 处理 buffer 中剩余的数据
      if (buffer.trim()) {
        try { processEvent(JSON.parse(buffer)) } catch {}
      }

      if (resultEvent) {
        let resultText = resultEvent.result || ''
        // Claude CLI 的 result 可能为空（最后一个 block 是 tool_use 时，如 TodoWrite）
        // fallback 到最后一个 text step 的完整文本
        if (!resultText.trim()) {
          const lastText = [...allSteps].reverse().find(s => s.type === 'text')
          resultText = lastText?.fullText || lastText?.content || ''
        }
        // ExitPlanMode 优先：plan 内容覆盖 result
        // CLI 默认 result text 通常只是"计划已写到 xxx.md"这类无意义确认，丢弃即可
        const hasExitPlan = !!(exitPlanData && exitPlanData.trim())
        if (hasExitPlan) {
          resultText = exitPlanData
        }
        const effectiveModel = resultEvent.model || model
        const mu = resultEvent.modelUsage?.[effectiveModel]
          || Object.values(resultEvent.modelUsage || {})[0]
        const contextLimit = mu?.contextWindow || 200000
        resolve({
          result: resultText,
          exitPlan: hasExitPlan,
          sessionId: resultEvent.session_id || knownSessionId || '',
          usage: resultEvent.usage || null,
          lastTurnUsage,
          costUsd: resultEvent.total_cost_usd || resultEvent.cost_usd || 0,
          model: effectiveModel,
          contextLimit,
          steps: allSteps,
        })
      } else if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`))
      } else {
        // 兜底：无 result 事件但进程正常退出，取最后一个 text step
        const lastText = [...allSteps].reverse().find(s => s.type === 'text')
        const hasExitPlan = !!(exitPlanData && exitPlanData.trim())
        const fallbackText = hasExitPlan
          ? exitPlanData
          : (lastText?.fullText || lastText?.content || '')
        resolve({
          result: fallbackText,
          exitPlan: hasExitPlan,
          sessionId: knownSessionId || '',
          usage: null,
          lastTurnUsage,
          costUsd: 0,
          steps: allSteps,
        })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  function abort() {
    if (proc && !aborted) {
      aborted = true
      proc.kill('SIGTERM')
    }
  }

  return { promise, abort, sessionId: knownSessionId }
}

module.exports = { callClaude }
