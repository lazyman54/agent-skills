# cr-resolve

A [Claude Code](https://claude.ai/code) skill that standardizes the process of handling **MR/PR Code Review feedback**.

> **The opposite of `/review`**: while `/review` is for _reviewing others' code_, `cr-resolve` is for _acting on feedback left on your own code_.

## What it does

1. **Fetches all MR comments** via `glab` and verifies completeness with a count check
2. **Classifies each comment** into three categories and shows a confirmation table
3. **Fixes each actionable item** in its own dedicated commit
4. **Replies to the original thread** with the commit ID after each fix
5. **Logs deferred issues** to your project backlog file with a structured TODO entry

## Install

```bash
npx skills add ericmao/agent-skills@cr-resolve -g
```

Or install all skills in this repo:

```bash
npx skills add ericmao/agent-skills -g
```

## Requirements

- [`glab`](https://gitlab.com/gitlab-org/cli) — GitLab CLI, installed and authenticated
- `python3` — for JSON parsing (standard on macOS/Linux)
- A GitLab MR to process

## Usage

Just describe what you want in natural language — the skill auto-triggers:

```
"handle the CR feedback on MR #12"
"fix the review comments on my MR"
"处理一下 MR #6 的 CR 反馈"
```

Or use it explicitly:

```
/cr-resolve 6
/cr-resolve 6 7    # multiple MRs at once
```

## Classification categories

| Category | Description |
|----------|-------------|
| **Actionable fix** | Clear code issue, original author agreed. Gets its own commit + thread reply. |
| **Clarified** | Already explained in the thread. No action needed. |
| **Deferred** | Out of scope for this PR. Logged to project backlog + thread reply explaining why. |

## Configuration

On first use, the skill will ask for two project-specific values:

- **Backlog file** — where to log deferred issues (e.g. `docs/TODO.md`, `BACKLOG.md`, or a link to your issue tracker)
- **Build & test command** — how to verify the project (e.g. `go test ./...`, `npm test`, `cargo test`)

## Example flow

```
User: "处理一下 MR #6 的 CR 反馈"

→ Fetches MR #6 comments (13/13 ✓)
→ Shows classification table, waits for confirmation
→ Fix 1: adds nil check → commit abc1234 → replies "Fixed in abc1234: added nil guard"
→ Fix 2: corrects comment typo → commit def5678 → replies "Fixed in def5678"
→ Deferred: logs redesign suggestion to docs/TODO.md → replies with explanation
→ Runs build + tests (all green)
→ git push
```

## License

MIT
