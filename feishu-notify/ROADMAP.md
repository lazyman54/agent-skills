# ROADMAP — 版本状态与路线图

> **AI-Notify (for Feishu/Lark)**：本文记录当前实现状态与演进方向。
>
> 已发现的 bug 和具体实现细节请在 GitHub Issues 提交。

---

## 当前版本（v1.x）

> 基于 Claude Code Hook 体系完整实现；Cursor 通知类可用，权限类部分支持。

### 已实现功能

| 功能 | 状态 | 说明 |
|------|------|------|
| Stop 通知（绿色/橙色卡片） | ✅ | 末尾问句自动切橙色「等待回复」 |
| TaskCompleted 通知 | ✅ | 显示 `#task_id subject` |
| PermissionRequest 飞书批准/拒绝 | ✅ | 黄色交互卡片，5 分钟超时 |
| AskUserQuestion 选项卡片 | ✅ | 支持多选项按钮，结果回写 Claude |
| 终端批准后飞书卡片同步 | ✅ | PostToolUse 触发，patch 卡片为已决策状态 |
| feishu-approve CLI | ✅ | list / approve / deny，支持 token 参数 |
| Webhook 降级 | ✅ | bot 不可用时 Stop/TaskCompleted 降级发 Webhook |
| macOS 系统通知 | ✅ | 每次 Stop 同时发系统通知 |
| Cursor stop 通知 | ✅ | cursor/install.sh 一键安装 |
| Admin 面板 | ✅ | http://localhost:13380/admin（token 保护） |
| 全局 Hook 注册 | ✅ | 写入 `~/.claude/ft-settings.json` 对所有项目生效 |

### 已知限制

- Cursor 的 PermissionRequest 仅支持 `beforeShellExecution`（Shell 命令），无法覆盖文件编辑类工具
- 飞书卡片回调需要 bot 公网可达（本地开发需内网穿透）
- 每日工作汇总需手动触发，无自动定时发送

---

## 近期规划

预计在接下来 1–2 个迭代内实现：

- [ ] **多 Webhook 支持**
  不同项目发到不同飞书群。Hook 脚本优先读环境变量 `FEISHU_WEBHOOK`，未设置则 fallback 到 `config.json` 默认值。适合多项目工作场景。

- [ ] **PermissionRequest 升级**
  使用飞书应用级权限（而非 Webhook）支持真正的卡片按钮回调，无需内网穿透。当前依赖 `card.action.trigger` 事件，需要 bot 服务公网可达。

---

## 中期规划

预计 1–3 个月内：

- [ ] **Stop 区分聊天 vs 任务执行**
  检查 transcript 中最后一条 assistant 消息是否含 `tool_use` 类型：有则判定为「任务执行」（通知摘要），无则判定为「纯聊天」（可选不通知或降低优先级）。

- [ ] **耗时统计**
  从 transcript JSONL 中读取最后一条 `user` 消息和最后一条 `assistant` 消息的时间戳，计算本轮耗时，附在 Stop 卡片上。

- [ ] **卡片显示当前 git branch**
  在 Stop 和 TaskCompleted 卡片中加入当前 git branch 信息：`subprocess.run(['git', '-C', cwd, 'branch', '--show-current'])`。

---

## 长期规划

优先级较低，等近/中期完成后评估：

- [ ] **每日工作汇总卡片**
  每天结束（或用户触发）发送当天的任务完成数、工具调用次数、累计耗时等统计。需要 transcript 聚合逻辑。

- [ ] **StopFailure hook**
  Claude 异常中断（非正常 Stop）时发红色告警卡片。需要 Claude Code 暴露对应事件或通过超时检测实现。

- [ ] **Linux 系统通知**
  用 `notify-send` 替代 `osascript`，在 `platform.system()` 判断后分支执行，支持 Linux 桌面环境。

---

## 不在范围内

以下需求明确不在本项目范围：

| 需求 | 原因 |
|------|------|
| 替代 Claude Code 权限系统 | feishu-notify 是增强层，不修改 Claude Code 本体 |
| 非 IM 通知渠道（邮件、SMS） | 范围外，可 fork 后自行替换 bot 发送逻辑 |
| 完整的工作流自动化（不需人工批准） | 与产品定位相悖；需要无感自动化请扩大 `permissions.allow` 列表 |
| 多用户/团队权限管理 | 目前设计为单用户本机部署，多用户场景需要较大架构改动 |

---

## 参与贡献

欢迎提交 PR，贡献前请先阅读 [DEVELOPER.md](./DEVELOPER.md)。

建议优先认领「近期规划」中的任务，这些任务有明确的实现思路，工作量在 1–3 天内可完成。
