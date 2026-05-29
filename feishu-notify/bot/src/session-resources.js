'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const LOCKS_DIR = path.join(__dirname, '../.claude/gitlab-projects/.locks')

/**
 * 清理指定会话的所有资源（frpc 服务进程 + gitlab 临时目录占用）
 */
function cleanupSession(sessionKey) {
  const dir = path.join(LOCKS_DIR, sessionKey)
  if (!fs.existsSync(dir)) return

  // 1. 清理 frpc 服务进程
  const frpcFile = path.join(dir, 'frpc-services.jsonl')
  if (fs.existsSync(frpcFile)) {
    for (const line of fs.readFileSync(frpcFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const { pid, port } = JSON.parse(line)
        // 尝试 kill PID
        if (pid) {
          try { process.kill(pid, 'SIGTERM') } catch {}
        }
        // fallback: 按端口 kill（PID 可能已失效但端口仍被占）
        if (port) {
          try { execSync(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 5000 }) } catch {}
        }
        console.log(`[session-resources] killed frpc service pid=${pid} port=${port}`)
      } catch {}
    }
  }

  // 2. 释放 gitlab 目录占用
  const gitlabFile = path.join(dir, 'gitlab-dirs.txt')
  if (fs.existsSync(gitlabFile)) {
    for (const line of fs.readFileSync(gitlabFile, 'utf8').split('\n')) {
      const dirPath = line.trim()
      if (!dirPath) continue
      try {
        const ownerFile = path.join(dirPath, '.session_owner')
        if (/_\d+\/?$/.test(dirPath)) {
          // 临时目录（<project>_<pid>/ 格式）→ rm -rf
          if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true })
            console.log(`[session-resources] removed temp gitlab dir: ${path.basename(dirPath)}`)
          }
        } else if (fs.existsSync(ownerFile)) {
          // 共享目录 → 只删 .session_owner 释放占用，保留代码
          fs.unlinkSync(ownerFile)
          console.log(`[session-resources] released gitlab dir: ${path.basename(dirPath)}`)
        }
      } catch {}
    }
  }

  // 3. 删除资源目录
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

/**
 * 清理所有会话资源（优雅退出时调用）
 */
function cleanupAll() {
  if (!fs.existsSync(LOCKS_DIR)) return
  try {
    for (const entry of fs.readdirSync(LOCKS_DIR)) {
      cleanupSession(entry)
    }
  } catch (err) {
    console.error('[session-resources] cleanupAll failed:', err.message)
  }
}

/**
 * 定期扫描：kill 未注册但 binary 在 gitlab-projects 下的监听进程（兜底保险）
 */
const GITLAB_PROJECTS_DIR = path.join(__dirname, '../.claude/gitlab-projects')

function cleanupOrphans() {
  // 1. 收集所有已注册的 PID
  const registeredPids = new Set()
  if (fs.existsSync(LOCKS_DIR)) {
    try {
      for (const entry of fs.readdirSync(LOCKS_DIR)) {
        const frpcFile = path.join(LOCKS_DIR, entry, 'frpc-services.jsonl')
        if (!fs.existsSync(frpcFile)) continue
        for (const line of fs.readFileSync(frpcFile, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try { registeredPids.add(JSON.parse(line).pid) } catch {}
        }
      }
    } catch {}
  }

  // 2. 扫描所有监听进程，检查 binary 是否在 gitlab-projects 下
  try {
    const result = execSync('ss -tlnp 2>/dev/null', { timeout: 5000 }).toString()
    for (const line of result.split('\n')) {
      const pidMatch = line.match(/pid=(\d+)/)
      if (!pidMatch) continue
      const pid = parseInt(pidMatch[1])
      if (registeredPids.has(pid)) continue

      try {
        const exe = fs.readlinkSync(`/proc/${pid}/exe`)
        if (exe.startsWith(GITLAB_PROJECTS_DIR)) {
          console.log(`[session-resources] killing orphan frpc process pid=${pid} exe=${path.basename(exe)}`)
          process.kill(pid, 'SIGTERM')
        }
      } catch {}
    }
  } catch {}
}

/**
 * 定期扫描：清理不属于任何活跃会话的临时 git 仓库目录（<project>_<pid>/ 格式）
 * 判断依据：是否被任何 .locks/<sessionKey>/gitlab-dirs.txt 注册，而非 PID 存活
 */
function cleanupStaleTempDirs() {
  if (!fs.existsSync(GITLAB_PROJECTS_DIR)) return
  try {
    // 1. 收集所有活跃会话注册的目录
    const registeredDirs = new Set()
    if (fs.existsSync(LOCKS_DIR)) {
      for (const entry of fs.readdirSync(LOCKS_DIR)) {
        const gitlabFile = path.join(LOCKS_DIR, entry, 'gitlab-dirs.txt')
        if (!fs.existsSync(gitlabFile)) continue
        for (const line of fs.readFileSync(gitlabFile, 'utf8').split('\n')) {
          if (line.trim()) registeredDirs.add(line.trim())
        }
      }
    }

    // 2. 扫描临时目录，删除未被任何会话注册的
    for (const entry of fs.readdirSync(GITLAB_PROJECTS_DIR)) {
      if (!/_\d+$/.test(entry)) continue
      const dirPath = path.join(GITLAB_PROJECTS_DIR, entry)
      if (!fs.statSync(dirPath).isDirectory()) continue
      if (registeredDirs.has(dirPath)) continue

      fs.rmSync(dirPath, { recursive: true, force: true })
      console.log(`[session-resources] removed stale temp dir: ${entry}`)
    }
  } catch (err) {
    console.error('[session-resources] cleanupStaleTempDirs failed:', err.message)
  }
}

// 每 10 分钟扫描一次孤儿进程 + 过期临时目录
setInterval(() => {
  cleanupOrphans()
  cleanupStaleTempDirs()
}, 600000)

module.exports = { cleanupSession, cleanupAll, cleanupOrphans, cleanupStaleTempDirs }
