# AI-Notify (for Feishu/Lark) — 产品文档设计稿

**日期**：2026-05-25  
**需求方**：ericmao  
**文档目的**：为 feishu-notify 项目设计一套完整的产品文档体系，同时服务用户（安装/使用）、架构师（系统设计）和研发（扩展开发）。

---

## 背景与目标

### 产品定位

**AI-Notify (for Feishu/Lark)**（repo 名保持 `feishu-notify`）：Claude Code / Cursor 执行任务时，通过飞书推送状态与交互卡片，让用户在手机或其他设备上感知 Agent 进度，并在飞书内批准权限。

### 文档目标

| 目标 | 说明 |
|------|------|
| 服务用户 | 任何开发者能在 30 分钟内装好并收到第一条通知 |
| 服务架构师 | 清晰理解系统设计、组件职责、数据流和安全边界 |
| 服务研发 | 能独立新增 Hook、修改卡片、移植到其他 IM 平台 |
| 开源就绪 | 文档结构符合 GitHub 开源项目惯例，可直接发布 |

### 约束

- 先本地 Markdown，写完后同步飞书知识库
- 完整路线图（近/中/长期）纳入文档，标注阶段
- 双名并存：主名 **AI-Notify**，副标题 "for Feishu/Lark"，repo 名 `feishu-notify` 不变

---

## 文档集设计：标准五件套

```
feishu-notify/
├── README.md          # 产品名片（重写）
├── USER_GUIDE.md      # 用户安装与使用指南（整合现有 GUIDE.md）
├── ARCHITECTURE.md    # 系统架构与设计（新建）
├── DEVELOPER.md       # 研发扩展指引（新建）
└── ROADMAP.md         # 版本状态与路线图（新建，公开 TODO.md 内容）
```

现有文件处理：
- `GUIDE.md` → 内容拆分到 `USER_GUIDE.md` + `ARCHITECTURE.md`，原文件保留重定向说明或删除
- `CONTEXT.md` → 保留（AI agent 专用上下文，不对外）
- `README.md` → 完全重写

---

## 各文档详细设计

### 1. README.md
**读者**：所有人（用户、架构师、研发、开源社区）  
**目标**：30 秒内让陌生人决定要不要用，会用就直接开始  
**篇幅**：~100 行，不超过 150 行

**章节结构**：
```
# AI-Notify (for Feishu/Lark)
> 一句话：Claude Code 任务推进时，飞书实时通知 + 移动端点击批准权限

## 效果预览          ← 1–2 张卡片截图（最有说服力）
## 能力矩阵          ← 表格：能力 × 模式（仅Webhook / +Bot / Claude Code / Cursor）
## 架构概览          ← mermaid 简图（3 个框：hooks → bot → 飞书）
## 快速安装          ← 5 步，预计 3 分钟
## 文档导航          ← → USER_GUIDE / ARCHITECTURE / DEVELOPER / ROADMAP
## License
```

---

### 2. USER_GUIDE.md
**读者**：想安装和日常使用的开发者  
**目标**：从零到收到第一条通知，遇到问题能自排  
**篇幅**：~300–400 行

**章节结构**：
```
## 前置条件
  - 飞书应用（appId / appSecret）
  - Python 3.8+、Node.js 18+、pm2
  - Claude Code 已安装

## 安装步骤
  ### 步骤 1：克隆仓库
  ### 步骤 2：配置飞书 Bot（config.json）
  ### 步骤 3：安装并启动 feishu-notify-bot
  ### 步骤 4：建立 Hook symlink
  ### 步骤 5：注册全局 Hook（ft-settings.json）
  ### 步骤 6：验证（validate 脚本）

## 日常使用
  ### 通知卡片说明（Stop / TaskCompleted / PermissionRequest）
  ### 在飞书批准/拒绝权限
  ### 在飞书回答 AskUserQuestion
  ### feishu-approve CLI 终端批准
  ### /stop-notify 静音

## Cursor IDE（可选）

## 排障手册
  ### 常见问题 Q&A
  ### 验证命令速查

## 已知坑与注意事项
  - heredoc 不可用
  - 字段名以实测为准（task_subject 等）
  - 卡片发到群里，不是私聊
```

---

### 3. ARCHITECTURE.md
**读者**：架构师，想深入理解系统设计  
**目标**：读完能画出完整的系统图，理解每个设计决策的 Why  
**篇幅**：~200–300 行

**章节结构**：
```
## 设计目标与约束
  - 离线感知：离开终端也能收到通知
  - 低延迟权限批准：30 秒内从飞书完成批准
  - 不修改 Claude Code 本体：纯 Hook 机制

## 组件全景
  | 组件 | 技术 | 职责 |
  | Python hooks | Python 3 | 监听 Claude 生命周期事件，调 bot 或 Webhook |
  | feishu-notify-bot | Node.js :13380 | 飞书互动卡片、回调处理、决策总线协调 |
  | 决策总线 | /tmp 文件 | Hook ↔ Bot ↔ CLI 三方通信，first-writer-wins |
  | feishu-approve CLI | Bash | 终端侧备用批准入口 |

## 完整数据流（mermaid 详图）
  - PermissionRequest 端到端（最复杂，详细展开）
  - Stop 端到端
  - TaskCompleted 端到端
  - PostToolUse 同步流程

## 决策总线设计
  - /tmp 文件协议（4 个路径的含义）
  - first-writer-wins 语义
  - 超时与清理

## 降级策略
  - bot 不可用时走 Webhook（通知类降级，权限类不降级）

## 安全考量
  - 凭证管理（config.json gitignore，勿硬编码）
  - 卡片回调验证（飞书签名）
  - admin token 保护

## 技术栈与依赖
```

---

### 4. DEVELOPER.md
**读者**：想扩展、贡献或移植的研发  
**目标**：能独立新增一个 Hook 事件，或把通知移植到 Slack  
**篇幅**：~300–400 行

**章节结构**：
```
## 代码结构
  feishu-notify/ 目录树 + 各目录/文件职责一句话说明

## Hook 开发规范
  ### Claude Code Hook 机制简介（stdin/stdout 协议）
  ### 各事件 stdin 字段速查表
    | 事件 | 关键字段 | 类型 | 说明 |
    | Stop | last_assistant_message | str | ... |
    | PermissionRequest | tool_name, tool_input | str/dict | ... |
    | TaskCompleted | task_subject | str | 注意不是 task_name |
    ...
  ### hookSpecificOutput 协议（PermissionRequest allow/deny/answer）

## 新增 Hook 手把手示例
  以"新增 PreToolUse 通知"为例，完整代码 + 注册方式

## Bot HTTP API 文档
  ### POST /permission-request
  ### POST /stop-notify
  ### POST /task-completed
  ### POST /ask-user-request
  ### POST /decision
  ### POST /question-synced
  ### GET /health
  ### GET /admin/api/stats

## 卡片模板修改
  - 修改文案（hooks/*.py 里的 lines 数组）
  - 修改颜色（header color 参数）
  - 新增按钮（bot/src/ 卡片模板）

## 调试指南
  - hook_debug.json 临时调试
  - validate-permission-flow.sh 端到端验证

## 移植到其他 IM 平台
  - 需要替换的接口（sendCard / patchCard / 回调处理）
  - 保留不变的部分（决策总线、Hook 逻辑）
```

---

### 5. ROADMAP.md
**读者**：所有人  
**目标**：了解产品现状和演进方向，贡献者可认领任务  
**篇幅**：~100–150 行

**章节结构**：
```
## 当前版本（v1.x）
  已实现功能清单（含 Claude Code + Cursor 支持矩阵）

## 近期规划
  - [ ] 多 Webhook：不同项目发到不同飞书群（env var FEISHU_WEBHOOK）
  - [ ] PermissionRequest 升级：使用飞书应用级权限支持按钮回调

## 中期规划
  - [ ] Stop 区分聊天 vs 执行任务（检查 transcript tool_use）
  - [ ] 耗时统计：从 transcript 时间戳计算本轮耗时
  - [ ] 卡片显示当前 git branch

## 长期规划
  - [ ] 每日工作汇总卡片
  - [ ] StopFailure hook：异常中断发红色告警
  - [ ] Linux 系统通知（notify-send 替代 osascript）

## 不在范围内
  - 替代 Claude Code 本体功能
  - 非 IM 通知渠道（邮件、SMS）
```

---

## 现有文档迁移计划

| 现有文件 | 处理方式 |
|----------|----------|
| `README.md` | 完全重写为新设计 |
| `GUIDE.md` | 内容拆入 USER_GUIDE.md + ARCHITECTURE.md；保留指向新文档的重定向说明 |
| `CONTEXT.md` | 保留不动（AI agent 专用，不对外） |
| `TODO.md` | 内容整合进 ROADMAP.md；TODO.md 本身继续作为本地草稿 |
| `AI-Notify/README.md` | 更新为指向 feishu-notify 主仓的导航页 |
| `AI-Notify/CONTEXT.md` | 保留不动（运维备忘） |

---

## 成功标准

- [ ] 一个从未接触过本项目的开发者，只看 README + USER_GUIDE，能在 30 分钟内完成安装
- [ ] 架构师读完 ARCHITECTURE.md，能不看代码独立画出完整数据流图
- [ ] 研发读完 DEVELOPER.md，能新增一个自定义 Hook 事件
- [ ] Roadmap 清晰区分近/中/长期，贡献者能直接认领任务
