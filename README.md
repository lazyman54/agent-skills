# agent-skills

A collection of [Claude Code](https://claude.ai/code) skills for everyday development workflows.

## Install all skills

```bash
npx skills add ericmao/agent-skills -g
```

## Install a single skill

```bash
npx skills add ericmao/agent-skills@cr-resolve -g
```

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

### [self-test](./self-test/)

Self-tests a feature/branch end-to-end before commit/MR/merge, with plan + evidence merged into a single doc:
- Collects 4 input docs (PRD / 技术方案 / use-case / 已有测试用例) and surfaces conflicts for user confirmation before writing the plan
- Picks layout based on feature scope: single-file for one entry-point, directory-style (`README.md` + per-scene `.md`) for ≥ 2 entry-points
- Each scene organizes branches in **five-段式 + 3.X.Y numbering** (测试前检查 / 构造入参 / 预期结果 / 实际结果 / 判定) — stable GFM anchors, no duplicate-heading collisions
- "测试前检查" enforces the 三步检查法: pre-SELECT → setup → post-SELECT confirm, each step with explicit expected state
- Embeds real evidence (DB outputs / logs / RPC responses) directly into the doc — no scattered `evidence/round*/tc-*.log` files
- Ships a separate `templates/reviewer-checklist.md` with red-line items (A 真实性 / B 完整性 / C 三维度证据 / D 风险声明 / E 项目规范) for the reviewer
- UC numbers, table names, error code segments, service names all read from the consumer project's own use-case / 技术方案 / DB schema — no hardcoded assumptions

**Requires**: Project with `docs/` directory; UC编号 / DB schema / RPC 服务名 from the project's own use-case 文档

**Triggers**: "自测" / "测试计划" / "提测前" / "回归测试" / "用例缺口" / "对照需求测一遍" / "开发完了怎么测" / "validate against PRD before integration"

**Pair with**: `plan-coding` (one writes the feature, the other tests it)

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
