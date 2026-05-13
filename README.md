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

---

## License

MIT
