---
name: refine
description: Use when the user wants to refine, sharpen, improve, rewrite, or turn a rough coding request into a precise actionable spec before Claude Code executes it.
disable-model-invocation: true
---

# Refine

Use this skill to refine a rough coding request before acting on it.

Your job is to call the Codex Advisor bridge, show the refined spec, and stop for user confirmation. Do not implement the refined spec unless the user explicitly confirms.

## Workflow

1. Identify the exact user request to refine.
2. If the request is missing or ambiguous enough that there is nothing concrete to refine, ask for the request.
3. Run the bridge with the request text.
4. Show the refined spec exactly as returned.
5. Ask whether the user wants to run it as-is, revise it, or stop.

## Command

Prefer stdin so shell quoting cannot change the request:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" <<'CODEX_ADVISOR_REQUEST'
<request to refine>
CODEX_ADVISOR_REQUEST
```

## Output Rules

- Do not paraphrase the refined spec.
- Do not add extra implementation advice before the confirmation question.
- Do not execute the refined spec during the same turn unless the user already asked to both refine and run it.
- If the bridge fails, report the exact command failure briefly and do not invent a refined spec.
