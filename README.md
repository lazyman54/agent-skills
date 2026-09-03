# agent-skills

A collection of [Claude Code](https://claude.ai/code) skills for everyday development workflows.

## 目录

- [安装](#安装)
- [Skills](#skills)
- [License](#license)

## 安装

**主推内部 GitLab**（公司内网可达），GitHub 公开镜像作为外网备选。

### Install all skills

```bash
# 内部 GitLab（推荐）
npx skills add git@gitlab.futunn.com:ericmao/agent-skills.git -g

# GitHub 公开镜像（外网）
npx skills add lazyman54/agent-skills -g
```

### Install a single skill

```bash
# 内部 GitLab（推荐）
npx skills add git@gitlab.futunn.com:ericmao/agent-skills.git --skill auto-self-test -g

# GitHub 公开镜像（外网）
npx skills add lazyman54/agent-skills --skill auto-self-test -g
```

> **前置条件**：本机已装 `mycli`（连 dev/test 库用）并配置 `~/.myclirc` 别名（`dev` / `test` / `manager`）；内部 GitLab 安装需 SSH key 已配置。具体见各 skill 的 README。

---

## Skills

### [mr-review](./mr-review/)

Reviews someone else's GitLab MR end-to-end:
- Fetches diff + existing comments via Explore subagent (results in /tmp, main context stays lean)
- Analyzes against Go rules (go-coding, go-design-patterns, go-code-smells) and project constitution
- Organizes comments by file with severity (🔴 blocking / 🟡 suggestion / 🟢 nit) and rule source
- Waits for user confirmation before posting
- Posts one note per file + final summary; handles large MRs transparently

**Requires**: [`glab`](https://gitlab.com/gitlab-org/cli) (GitLab CLI)

**Triggers**: "review MR" / "CR别人代码" / "帮我看看这个MR" / "审查MR" / ...

**Pair with**: `cr-resolve` (handles review comments on your own MR)

### [cr-resolve](./cr-resolve/)

Handles MR/PR Code Review feedback end-to-end:
- Fetches all MR comments with count verification (no missing comments)
- Classifies each comment: actionable fix / clarified / deferred
- Fixes each actionable item in its own dedicated commit
- Replies to the original discussion thread with the commit ID
- Logs deferred issues to your project backlog

**Requires**: [`glab`](https://gitlab.com/gitlab-org/cli) (GitLab CLI) + `python3`

**Triggers**: "处理CR" / "fix CR" / "process MR feedback" / "resolve review comments" / ...

### [plan-coding](./plan-coding/)

Executes a DDD implementation plan phase end-to-end with structured guardrails:
- Spawns an Explore subagent to load context in parallel (impl-plan, domain-model, use-case, codebase skeleton)
- Checks phase dependencies before starting; surfaces ambiguities for confirmation
- Defines code skeleton first and waits for user sign-off before writing tests
- Follows strict layer order: domain → assembler → application → adapter
- Each UC gets its own commit (`feat(<scope>): UC-XXX ...`)
- Runs `go build` + `go test -cover` (domain ≥ 90%) before declaring done
- Triggers `/cr` as the final gate; updates impl-plan on success

**Requires**: Go project with DDD hexagonal architecture + `impl-plan.md`

**Triggers**: "实现阶段" / "编码阶段N" / "plan-coding" / "开始写阶段" / "implement phase"

### [auto-self-test](./auto-self-test/)

Self-tests a feature/branch end-to-end before commit/MR/merge, producing the **四件套** (README.md / plan.md / round_N.md / defects.md) with **4 维度判定** (数据 / 返回 / 日志 / 告警):
- 4 类输入文档 (PRD / 技术方案 / use-case / 已有测试用例) 逐项收集，拿不到显式标「无」+ 风险，不假装有依据
- Step 2 写 plan（只写「验什么」的 4 维度严格预期）+ dispatch subagent 代码预审，P0 bug 测前修掉
- Step 3 跑测按 4 维度取证入 round_N.md；e2e 优先，单测兜底（促成手段：改 SQL 造数据 / 手动触发 MQ / http 触发 cron）
- Step 4 缺陷入 defects.md，三件套根因（文件+行号 / 代码块带注释 / 一句话总结），每个缺陷独立 commit

**Requires**: Project with `docs/` directory; UC编号 / DB schema / RPC 服务名 from the project's own use-case 文档；配合 `querying-dev-test-db`（查库出证据）+ `observability-skills`（查日志/告警）

**Triggers**: "自测" / "测试计划" / "提测前" / "回归测试" / "用例缺口" / "对照需求测一遍" / "开发完了怎么测" / "提测自测" / "发版前自测"

**Pair with**: `querying-dev-test-db` (数据维度查库) / `observability-skills` (日志/告警维度) / `plan-coding` (一个写功能，一个测)

### [querying-dev-test-db](./querying-dev-test-db/)

Queries the dev/test MySQL database via the local `mycli` client — the data-dimension evidence source for self-test:
- 连接只用 `~/.myclirc` 的 DSN 别名（`dev` / `test` / `manager`），命令里永不写明文密码
- 内置 `\f` 收藏查询（node / ins / sta / qsl / myw / mydesc…），查 `node_execution_record` / `workflow_instance` / `workflow_summary` 开箱即用
- bigint 毫秒时间戳归一：`FROM_UNIXTIME(create_time/1000)`；`trigger_expire_at` 13/16 位混存按位数归一
- 护栏：只读查询（无 UPDATE/DELETE/DROP），日常用 `dev` 不用 `dev-root`

**Requires**: `mycli` 已安装 + `~/.myclirc` 配好 `[alias_dsn]` 别名（含明文密码，不得 commit）

**Triggers**: "查 dev 库" / "查 test 库" / "用 mycli 查数据库" / "看表数据" / "查 node_execution_record" / "bigint 时间转换"

**Pair with**: `auto-self-test` (Step 3 数据维度查库出证据) / `test-env-triage` (排查时查数据)

### [test-env-triage](./test-env-triage/)

Triages dev/test environment problems by routing the symptom to the right layer and tool, instead of guessing or grepping blindly:
- Four trunks by symptom: RPC/interface error, stuck workflow, wrong data, service/config/task failure
- Narrows layer by layer (返回码 → 日志 → 数据 → 代码), stopping as soon as the root-cause layer is confirmed with evidence
- Project-specific tool discipline: `mycli` for the test DB (not `mysql -u root`), `observability-skills` for logs/trace, bigint-ms timestamp conversion, 包头/包体 two-layer error codes
- A concretization of `systematic-debugging` Phase 1 — locates root cause, then hands off the fix
- Built and validated with the writing-skills TDD loop (baseline → skill → verify)

**Requires**: 测试环境工具链 — `mycli` (test DB) + `observability-skills` (FLS logs/trace) + FRPC 服务

**Triggers**: "排查" / "测试环境出问题" / "接口报错怎么查" / "工作流卡住" / "数据不对" / "从哪开始查" / "定位根因"

**Pair with**: `auto-self-test` (one proactively validates, one triages failures) / `systematic-debugging` (deep root-cause + fix)

### [rules-maintain](./rules-maintain/)

Manages global Claude behavior rules in `~/.claude/rules/` and `~/.claude/CLAUDE.md`:
- Judges whether a recurring constraint warrants a global rule (two-filter: cross-project + will-repeat)
- Routes to the right file: CLAUDE.md for top-level principles, rules/*.md for domain-specific constraints
- Deduplicates before writing (grep check across all rule files)
- Writes with correct frontmatter (`alwaysApply` or `globs`) and structured format
- Audit mode: lists all rules, flags redundancy, missing frontmatter, and overly vague entries

**Requires**: `~/.claude/rules/` directory

**Triggers**: "加个全局规则" / "记住这个行为约束" / "全局规则整理" / "审查全局rules" / "audit rules" / ...

### [spec-maintain](./spec-maintain/)

Captures missing project conventions discovered during code review into the project spec file:
- Identifies whether a reviewer comment reveals a general architectural/project-specific convention
- Locates the spec file (`.specify/memory/constitution.md` or `AGENTS.md`)
- Deduplicates before writing (grep check)
- Writes the convention in a structured format to the correct section
- Suggests a standalone commit for the spec change

**Requires**: Project with `.specify/memory/constitution.md` or `AGENTS.md`

**Triggers**: "规范缺失" / "这条规范要不要加到文档" / "update project spec" / "sync convention to spec" / ...

### [feishu-notify](./feishu-notify/)

Get notified on **Lark/Feishu** whenever Claude Code finishes a response, completes a task, or needs your approval — so you can step away from the terminal without missing anything.

- 4 notification types: completed reply, waiting for input, task done, permission request
- Each card shows: session name, project, timestamp, your last input, Claude's reply summary
- macOS system notification fired simultaneously
- Works across all projects — scripts live in `~/.claude/hooks/`, just add config per project

**Requires**: Python 3 + a Lark/Feishu group webhook bot

**Not a slash command** — this is a hooks setup guide. See [feishu-notify/README.md](./feishu-notify/README.md) for installation steps.

---

## License

MIT
