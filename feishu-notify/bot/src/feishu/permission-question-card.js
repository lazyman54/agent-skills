'use strict'

const fs = require('fs')
const path = require('path')
const messageSender = require('./message-sender')
const { loadCardMeta, saveCardMeta, removeCardMeta } = require('./permission-card')
const QUESTION_NUM_EMOJIS = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3']

// Claude Code 终端在 AskUserQuestion 上额外提供的元操作（不在 questions[].options 里）
const TUI_META_ACTIONS = [
  { display: '💬 Chat about this', answerLabel: 'Chat about this' },
  { display: '⏭️ Skip interview', answerLabel: 'Skip interview and plan immediately' },
]

function appendButtonRow(elements, buttons) {
  if (!buttons.length) return
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

function buildPermissionQuestionCard(token, questions, project) {
  const elements = []

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    if (qi > 0) elements.push({ tag: 'hr' })

    elements.push({
      tag: 'markdown',
      content: `**${q.header || '问题'}**\n\n${q.question}`,
    })

    const opts = q.options || []
    if (opts.some(o => o.description)) {
      let descMd = ''
      opts.forEach((opt, i) => {
        const num = QUESTION_NUM_EMOJIS[i] || `${i + 1}.`
        descMd += `${num} **${opt.label}** — ${opt.description || ''}\n`
      })
      elements.push({ tag: 'markdown', content: descMd })
    }

    if (!q.multiSelect) {
      const buttons = opts.map((opt, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: (opt.label || `选项${i + 1}`).slice(0, 20) },
        type: i === 0 ? 'primary' : 'default',
        value: { permToken: token, permKind: 'answer', qi, idx: i },
      }))
      appendButtonRow(elements, buttons)
    } else {
      elements.push({
        tag: 'markdown',
        content: '_多选暂不支持飞书按钮，请到 Claude Code 终端作答_',
      })
    }
  }

  // 终端同款元操作（单题时与 Claude TUI 对齐）
  if (questions.length === 1 && !questions[0]?.multiSelect) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'markdown',
      content: '_其他操作（与终端一致）_',
      text_size: 'notation',
    })
    appendButtonRow(elements, TUI_META_ACTIONS.map((m, i) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: m.display.slice(0, 20) },
      type: i === 0 ? 'default' : 'default',
      value: { permToken: token, permKind: 'meta', answerLabel: m.answerLabel },
    })))
    elements.push({
      tag: 'markdown',
      content: '_自定义文字（Type something）请到终端，或在本群**回复消息**说明你的选择_',
      text_size: 'notation',
    })
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: `**项目**: ${project || '-'}\n\n点击选项或上方元操作；与终端二选一即可`,
    text_size: 'notation',
  })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '💬 Claude 需要你选择' },
      template: 'blue',
    },
    body: { elements },
  }
}

function countAnswered(answersByQi, total) {
  let n = 0
  for (let i = 0; i < total; i++) {
    if (answersByQi[i] != null) n++
  }
  return n
}

function buildQuestionAnsweredCard(questions, answersByQi, project, source) {
  const lines = [`**项目**: ${project || '-'}`]
  if (source && source !== 'feishu') {
    lines.push(`**处理**: ${source === 'claude_terminal' ? 'Claude Code 终端' : source}`)
  }
  questions.forEach((q, qi) => {
    const label = answersByQi[qi] || '-'
    lines.push('', `**${q.header || '问题'}**`, q.question, `→ **${label}**`)
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 已全部作答' },
      template: 'green',
    },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
  }
}

/** 多题未答完：保留未答题的按钮，已答的显示选项 */
function buildQuestionProgressCard(token, questions, answersByQi, project) {
  const elements = []
  const answered = countAnswered(answersByQi, questions.length)
  const total = questions.length

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]
    if (qi > 0) elements.push({ tag: 'hr' })
    const done = answersByQi[qi] != null
    elements.push({
      tag: 'markdown',
      content: done
        ? `**${q.header || '问题'}** ✅\n\n${q.question}\n\n→ **${answersByQi[qi]}**`
        : `**${q.header || '问题'}** ⏳\n\n${q.question}`,
    })
    if (!done && !q.multiSelect) {
      const opts = q.options || []
      const buttons = opts.map((opt, i) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: (opt.label || `选项${i + 1}`).slice(0, 20) },
        type: i === 0 ? 'primary' : 'default',
        value: { permToken: token, permKind: 'answer', qi, idx: i },
      }))
      appendButtonRow(elements, buttons)
    } else if (!done && q.multiSelect) {
      elements.push({
        tag: 'markdown',
        content: '_多选请到 Claude Code 终端作答_',
      })
    }
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: `**项目**: ${project || '-'}\n\n进度 **${answered}/${total}** — 请继续点击未答题的选项`,
    text_size: 'notation',
  })

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `💬 请继续选择 (${answered}/${total})` },
      template: 'blue',
    },
    body: { elements },
  }
}

function allQuestionsAnswered(questions, answersByQi) {
  return questions.every((_, i) => answersByQi[i] != null)
}

function writeQuestionResult(token, body) {
  const filePath = `/tmp/claude_perm_${token}`
  const content = JSON.stringify(body)
  try {
    const fd = fs.openSync(filePath, 'wx', 0o600)
    fs.writeSync(fd, content, 'utf8')
    fs.closeSync(fd)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

function buildUpdatedInput(questions, answersByQi) {
  const answers = {}
  questions.forEach((q, qi) => {
    if (answersByQi[qi] != null) {
      answers[q.question] = answersByQi[qi]
    }
  })
  return { questions, answers }
}

async function applyQuestionAnswerWithLabel(token, qi, label, source = 'feishu') {
  const meta = loadCardMeta(token)
  if (!meta || meta.type !== 'ask_user') {
    return { ok: false, reason: 'unknown_token' }
  }

  const questions = meta.questions || []
  if (!questions[qi]) return { ok: false, reason: 'invalid_question_index' }

  const partial = { ...(meta.partialAnswers || {}), [qi]: label }

  if (!allQuestionsAnswered(questions, partial)) {
    meta.partialAnswers = partial
    saveCardMeta(token, meta)
    const { messageId } = meta
    if (messageId) {
      await messageSender.patchCard(
        messageId,
        buildQuestionProgressCard(token, questions, partial, meta.project),
      )
    }
    const answered = countAnswered(partial, questions.length)
    return { ok: true, pending: true, answered, total: questions.length }
  }

  const updatedInput = buildUpdatedInput(questions, partial)
  writeQuestionResult(token, {
    decision: 'answer',
    source,
    updatedInput,
  })

  const { messageId, ...rest } = meta
  if (messageId) {
    await messageSender.patchCard(
      messageId,
      buildQuestionAnsweredCard(questions, partial, meta.project, source),
    )
  }

  removeCardMeta(token)
  return { ok: true, pending: false, updatedInput }
}

/**
 * 飞书按钮选题回调（按 options 下标）
 */
async function applyQuestionAnswer(token, qi, idx, source = 'feishu') {
  const meta = loadCardMeta(token)
  if (!meta || meta.type !== 'ask_user') {
    return { ok: false, reason: 'unknown_token' }
  }
  const q = (meta.questions || [])[qi]
  if (!q) return { ok: false, reason: 'invalid_question_index' }
  const opt = (q.options || [])[idx]
  const label = opt ? opt.label : String(idx + 1)
  return applyQuestionAnswerWithLabel(token, qi, label, source)
}

/**
 * 终端元操作：Chat about this / Skip interview 等
 */
async function applyMetaAction(token, answerLabel, source = 'feishu') {
  return applyQuestionAnswerWithLabel(token, 0, answerLabel, source)
}

/**
 * 终端 / PostToolUse 已选题：只更新飞书卡片，不写结果文件（由 Python hook 写入）
 */
async function syncQuestionFromTerminal(token, updatedInput, source = 'claude_terminal') {
  const meta = loadCardMeta(token)
  if (!meta || meta.type !== 'ask_user') {
    return { ok: false, reason: 'unknown_token' }
  }

  const questions = meta.questions || []
  const answers = updatedInput?.answers || {}
  const partial = { ...(meta.partialAnswers || {}) }
  questions.forEach((q, qi) => {
    if (answers[q.question] != null) {
      partial[qi] = answers[q.question]
    }
  })

  const { messageId, project } = meta
  if (!allQuestionsAnswered(questions, partial)) {
    meta.partialAnswers = partial
    saveCardMeta(token, meta)
    if (messageId) {
      await messageSender.patchCard(
        messageId,
        buildQuestionProgressCard(token, questions, partial, project),
      )
    }
    return { ok: true, pending: true, reason: 'partial_answers' }
  }

  if (messageId) {
    await messageSender.patchCard(
      messageId,
      buildQuestionAnsweredCard(questions, partial, project, source),
    )
  }
  removeCardMeta(token)
  return { ok: true, pending: false }
}

async function sendPermissionQuestionCard(receiveIdType, receiveId, token, { project, questions }) {
  const card = buildPermissionQuestionCard(token, questions, project)
  const res = await messageSender.sendMessage(receiveIdType, receiveId, JSON.stringify(card), 'interactive')
  const messageId = res?.data?.message_id || ''
  const meta = {
    type: 'ask_user',
    toolName: 'AskUserQuestion',
    project,
    questions,
    messageId,
    partialAnswers: {},
  }
  saveCardMeta(token, meta)
  return { messageId }
}

module.exports = {
  sendPermissionQuestionCard,
  applyQuestionAnswer,
  applyMetaAction,
  syncQuestionFromTerminal,
  buildPermissionQuestionCard,
  buildQuestionProgressCard,
  buildQuestionAnsweredCard,
  buildUpdatedInput,
  allQuestionsAnswered,
}
