#!/usr/bin/env python3
"""
Pre-commit / pre-push hook: 扫描 diff 中的公司相关信息。
- 发现内部域名 / 凭据 → 拦截
- 发现公司名称 → 警告，要求用户确认
- 干净 → 放行
"""
import json
import re
import subprocess
import sys


BLOCK_PATTERNS = [
    (r"[\w.-]+\.futunn\.com", "内部域名"),
    (r"(?:password|secret|token|api_key|apikey|access_key)\s*[:=]\s*[\"']?[A-Za-z0-9+/]{8,}", "疑似凭据"),
    (r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "内网 IP"),
]

WARN_PATTERNS = [
    (r"(?:futunn|富途)", "公司名称"),
]


def get_diff(is_commit: bool) -> str:
    try:
        root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
        if is_commit:
            return subprocess.check_output(["git", "diff", "--cached"], cwd=root, text=True)
        else:
            try:
                return subprocess.check_output(
                    ["git", "diff", "origin/HEAD..HEAD"], cwd=root, text=True
                )
            except subprocess.CalledProcessError:
                return subprocess.check_output(
                    ["git", "diff", "HEAD~1..HEAD"], cwd=root, text=True
                )
    except Exception:
        return ""


def added_lines(diff: str) -> str:
    return "\n".join(
        l[1:] for l in diff.splitlines()
        if l.startswith("+") and not l.startswith("+++")
    )


def scan(text: str, patterns: list) -> list[str]:
    findings = []
    for pattern, label in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            examples = list(dict.fromkeys(matches))[:2]
            findings.append(f"{label}: {', '.join(str(e)[:60] for e in examples)}")
    return findings


def block_output(findings: list[str]) -> None:
    msg = "🚫 发现公司相关信息，已拦截：\n" + "\n".join(f"  • {f}" for f in findings)
    msg += "\n\n请移除上述内容后重试。"
    print(json.dumps({
        "continue": False,
        "stopReason": msg,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "包含公司内部信息",
        },
    }, ensure_ascii=False))


def warn_output(findings: list[str]) -> None:
    msg = "⚠️ 发现可能的公司相关内容，请确认是否可以公开提交：\n"
    msg += "\n".join(f"  • {f}" for f in findings)
    msg += "\n\n如确认安全请告知继续；如需移除请修改后重试。"
    print(json.dumps({
        "continue": False,
        "stopReason": msg,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "不确定是否含公司信息，需用户确认",
        },
    }, ensure_ascii=False))


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "").strip()
    if not re.match(r"^git\s+(commit|push)", command):
        sys.exit(0)

    is_commit = bool(re.match(r"^git\s+commit", command))
    diff = get_diff(is_commit)
    if not diff:
        sys.exit(0)

    text = added_lines(diff)
    if not text:
        sys.exit(0)

    block = scan(text, BLOCK_PATTERNS)
    if block:
        block_output(block)
        sys.exit(0)

    warn = scan(text, WARN_PATTERNS)
    if warn:
        warn_output(warn)
        sys.exit(0)


if __name__ == "__main__":
    main()
