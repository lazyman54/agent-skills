'use strict'

const { sanitizeText, applyMentions } = require('./message-sender')
const userCache = require('./user-cache')

// 内联兜底截断：原 doc-exporter.truncateForFeishu 功能迁移到此（文件级 local 复用）
function truncateForFeishu(text) {
  const MAX = 3800
  if (!text || text.length <= MAX) return text
  return text.slice(0, MAX) + '\n\n---\n⚠️ 内容过长已截断。请要求创建飞书文档承载完整内容。'
}

const CARD_TEXT_LIMIT = 15000   // 预截断阈值（字符数）
const CARD_JSON_LIMIT = 25600  // 卡片 JSON 安全限制（飞书限制 ~28KB）

/**
 * 将 @name 替换为飞书卡片 markdown 格式的 <at> 标签
 * 卡片格式: <at id=open_id></at>（不同于 text 消息的 <at user_id="open_id">name</at>）
 * 参考: https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-markdown-tags
 */
function applyCardMentions(text) {
  return text.replace(/@([a-zA-Z]\w{1,})/g, (match, name) => {
    const openId = userCache.getOpenId(name)
    if (openId) return `<at id=${openId}></at>`
    return match
  })
}

// --- Markdown 检测 ---

/**
 * 检测文本是否包含有意义的 Markdown 格式
 */
function hasMarkdown(text) {
  if (!text || text.length < 10) return false
  const patterns = [
    /\*\*[^*]+\*\*/,                       // **bold**
    /(?:^|\n)#{1,6}\s+\S/,                 // # heading
    /(?:^|\n)```/,                          // code block
    /(?:^|\n)\|.+\|.+\|/,                  // table row
    /(?:^|\n)\s*[-*+]\s+\S/,               // unordered list
    /(?:^|\n)\s*\d+\.\s+\S/,               // ordered list
    /(?:^|\n)>\s+\S/,                       // blockquote
    /\[([^\]]+)\]\(https?:\/\/[^)]+\)/,    // [text](url)
    /~~[^~]+~~/,                            // ~~strikethrough~~
    /`[^`]+`/,                              // `inline code`
  ]
  return patterns.some(p => p.test(text))
}

// --- 标题提取 ---

function extractTitle(text) {
  // 首行含 Markdown 链接 [text](url) 时跳过提取：卡片 header.title 为 plain_text，
  // 不渲染链接，会导致链接不可点击。保留首行在 body 中走 markdown 渲染。
  const firstLine = text.split('\n', 1)[0]
  const hasMarkdownLink = /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(firstLine)

  // 首行是 # heading
  const headingMatch = text.match(/^#{1,6}\s+(.+)/)
  if (headingMatch && !hasMarkdownLink) {
    return {
      title: headingMatch[1].replace(/\*\*/g, '').trim().slice(0, 60),
      body: text.slice(headingMatch[0].length).trimStart(),
    }
  }

  // 首行是 **Bold Title**（单独一行）
  const boldMatch = text.match(/^\*\*(.+?)\*\*\s*\n/)
  if (boldMatch && boldMatch[1].length <= 60 && !hasMarkdownLink) {
    return {
      title: boldMatch[1].trim(),
      body: text.slice(boldMatch[0].length).trimStart(),
    }
  }

  // 无明确标题
  return { title: null, body: text }
}

// --- 内容分段 ---

/**
 * 将文本按 markdown / table 类型分段
 * 代码块内的 | 不会误判为表格
 */
function splitIntoSegments(text) {
  const segments = []
  const lines = text.split('\n')
  let currentMarkdown = []
  let tableLines = []
  let inTable = false
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 跟踪代码块状态
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      if (inTable) {
        // 代码块开始，先 flush 表格
        flushTable(segments, tableLines, currentMarkdown)
        tableLines = []
        inTable = false
      }
      currentMarkdown.push(line)
      continue
    }

    if (inCodeBlock) {
      currentMarkdown.push(line)
      continue
    }

    const trimmed = line.trim()
    const isTableRow = /^\|(.+\|)+\s*$/.test(trimmed)
    const isSeparator = /^\|[\s:|-]+\|\s*$/.test(trimmed)

    if (isTableRow || isSeparator) {
      if (!inTable) {
        // flush markdown
        if (currentMarkdown.length > 0) {
          segments.push({ type: 'markdown', content: currentMarkdown.join('\n') })
          currentMarkdown = []
        }
        inTable = true
      }
      tableLines.push(line)
    } else {
      if (inTable) {
        flushTable(segments, tableLines, currentMarkdown)
        tableLines = []
        inTable = false
      }
      currentMarkdown.push(line)
    }
  }

  // flush 剩余
  if (inTable) {
    flushTable(segments, tableLines, currentMarkdown)
  }
  if (currentMarkdown.length > 0) {
    segments.push({ type: 'markdown', content: currentMarkdown.join('\n') })
  }

  return segments
}

function flushTable(segments, tableLines, markdownFallback) {
  if (tableLines.length >= 2) {
    segments.push({ type: 'table', content: tableLines.join('\n') })
  } else {
    markdownFallback.push(...tableLines)
  }
}

// --- Markdown 语法转换 ---

function convertMarkdownSyntax(text) {
  let result = text

  // # heading → **heading**
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, (_, _hashes, content) => {
    return `**${content.trim()}**`
  })

  // > blockquote → 剥离前缀
  result = result.replace(/^>\s?(.*)$/gm, '$1')

  // 剥离 URL 周围的 bold 标记
  result = result.replace(/\*{1,2}(https?:\/\/[^\s*]+)\*{1,2}/g, '$1')

  // 清洗控制字符
  result = result
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g, '')

  // @mentions — 卡片 markdown 使用 <at id=open_id></at> 格式（不同于 text 消息的 <at user_id="...">）
  result = applyCardMentions(result)

  return result
}

// --- 表格转换 ---

function parseTableRow(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim())
}

// 裸 URL → [url](url),已是 [text](url) 的保留不动
function autoLinkUrls(text) {
  if (!text) return text
  const placeholders = []
  let out = text.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, (m) => {
    placeholders.push(m)
    return `\u0000${placeholders.length - 1}\u0000`
  })
  out = out.replace(
    /(https?:\/\/[^\s<>()\[\]]+[^\s<>()\[\].,;:!?'"])/g,
    (url) => `[${url}](${url})`,
  )
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => placeholders[Number(i)])
}

function convertTableToComponent(tableText) {
  const lines = tableText.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) {
    return { tag: 'markdown', content: tableText }
  }

  const headerCells = parseTableRow(lines[0])

  // 查找分隔行
  const sepIndex = lines.findIndex((l, i) => i > 0 && /^\|[\s:|-]+\|\s*$/.test(l.trim()))
  if (sepIndex < 0) {
    return { tag: 'markdown', content: tableText }
  }

  const dataLines = lines.slice(sepIndex + 1)
  const columns = headerCells.map((header, i) => ({
    name: `col_${i}`,
    display_name: header,
    data_type: 'lark_md',
    width: 'auto',
  }))

  const rows = dataLines.map(line => {
    const cells = parseTableRow(line)
    const row = {}
    headerCells.forEach((_, i) => {
      row[`col_${i}`] = autoLinkUrls(cells[i] || '')
    })
    return row
  })

  return {
    tag: 'table',
    page_size: Math.min(rows.length, 20),
    row_height: 'low',
    header_style: {
      text_align: 'center',
      text_size: 'normal',
      background_style: 'grey',
      bold: true,
    },
    columns,
    rows,
  }
}

// --- 卡片组装 ---

function assembleCard(title, elements) {
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  }

  if (title) {
    card.header = {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    }
  }

  return card
}

function trimCardToFit(card, sizeLimit) {
  const elements = card.body.elements
  while (elements.length > 1 && JSON.stringify(card).length > sizeLimit) {
    elements.pop()
  }

  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'markdown',
    content: '⚠️ 内容过长，已截断部分内容。',
  })

  return { card, overflow: null }
}

// --- 核心转换 ---

function buildMarkdownCard(text, options = {}) {
  // 预截断
  if (text.length > CARD_TEXT_LIMIT) {
    text = text.slice(0, CARD_TEXT_LIMIT) + '\n\n---\n⚠️ 内容过长，已截断部分内容。'
  }

  const { title, body } = extractTitle(text)
  const segments = splitIntoSegments(body)
  const elements = []

  // 群聊 @mention
  if (options.mentionOpenId) {
    elements.push({
      tag: 'markdown',
      content: `<at id=${options.mentionOpenId}></at>`,
    })
  }

  for (const seg of segments) {
    if (seg.type === 'table') {
      elements.push(convertTableToComponent(seg.content))
    } else {
      const converted = convertMarkdownSyntax(seg.content).trim()
      if (converted) {
        elements.push({ tag: 'markdown', content: converted })
      }
    }
  }

  // 空内容保护
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text })
  }

  const card = assembleCard(title, elements)

  // 大小检查
  if (JSON.stringify(card).length > CARD_JSON_LIMIT) {
    return trimCardToFit(card, CARD_JSON_LIMIT)
  }

  return { card, overflow: null }
}

// --- 集成入口 ---

/**
 * 格式化回复：自动检测 Markdown 并选择卡片或纯文本
 * @param {string} text - Claude 原始回复文本
 * @param {object} options
 * @param {string} [options.openId] - 群聊中用户的 openId（用于 @mention）
 * @param {string} [options.userId] - 用户名
 * @param {boolean} [options.isGroup] - 是否群聊
 * @returns {{ content: string, msgType: string }}
 */
function formatReply(text, options = {}) {
  try {
    // 去除首尾空白行（Claude 输出可能带 \n\n 前缀）
    text = (text || '').trim()
    if (!text) return buildTextReply('(空内容)', options)

    if (!hasMarkdown(text)) {
      return buildTextReply(text, options)
    }

    const { card } = buildMarkdownCard(text, {
      mentionOpenId: options.isGroup ? options.openId : null,
      mentionName: options.userId || 'user',
    })

    return {
      content: JSON.stringify(card),
      msgType: 'interactive',
    }
  } catch (err) {
    console.error('[markdown-to-card] Conversion failed, falling back to text:', err.message)
    return buildTextReply(text, options)
  }
}

function buildTextReply(text, options) {
  const truncated = truncateForFeishu(text)
  const cleaned = sanitizeText(truncated)
  const withMention = options.isGroup && options.openId
    ? `<at user_id="${options.openId}">${options.userId || 'user'}</at>\n${cleaned}`
    : cleaned
  return {
    content: JSON.stringify({ text: applyMentions(withMention) }),
    msgType: 'text',
  }
}

module.exports = { hasMarkdown, buildMarkdownCard, formatReply }
