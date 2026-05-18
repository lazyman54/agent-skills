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
