---
name: refine-with-context
description: Refine a rough coding request into a precise spec using current repository context before Claude Code executes it.
disable-model-invocation: true
---

# Refine With Context

Use this skill when the user explicitly invokes `/codex-advisor:refine-with-context` or asks to refine a request using current repository context.

Your job is to call the Codex Advisor bridge, show the refined spec, and stop for user confirmation. Do not implement the refined spec unless the user explicitly confirms.

## Workflow

1. Identify the exact user request to refine.
2. If the request is missing or too vague to refine, ask for the request.
3. Run the bridge with context-aware mode.
4. Show the refined spec exactly as returned.
5. Ask whether the user wants to run it as-is, revise it, or stop.

## Command

Pass the request on stdin so shell quoting cannot change it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --with-context <<'CODEX_ADVISOR_REQUEST'
<request to refine>
CODEX_ADVISOR_REQUEST
```

The bridge gathers a bounded file tree, current git status and diff, and ripgrep matches for relevant request terms before starting the Codex app-server turn.

## Output Rules

- Do not paraphrase the refined spec.
- Do not add extra implementation advice before the confirmation question.
- Do not execute the refined spec during the same turn unless the user already asked to both refine and run it.
- If the bridge fails, report the exact command failure briefly and do not invent a refined spec.
