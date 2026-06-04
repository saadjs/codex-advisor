---
name: refine-and-run
description: Refine a rough coding request using current repository context, then execute the refined spec in the same turn.
disable-model-invocation: true
---

# Refine And Run

Use this skill when the user explicitly invokes `/codex-advisor:refine-and-run` or asks to refine a request with repository context and then run the result immediately.

Your job is to call the Codex Advisor bridge in context-aware mode, show the refined spec exactly as returned, and then implement that refined spec in the same turn.

## Workflow

1. Identify the exact user request to refine and run.
2. If the request is missing or too vague to refine, ask for the request.
3. Run the bridge with context-aware mode.
4. Show the refined spec exactly as returned.
5. Treat the refined spec as the authoritative task and implement it.
6. Run appropriate verification before the final response.

## Command

Pass the request on stdin so shell quoting cannot change it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --with-context <<'CODEX_ADVISOR_REQUEST'
<request to refine and run>
CODEX_ADVISOR_REQUEST
```

The bridge gathers a bounded file tree, current git status and diff, and ripgrep matches for relevant request terms before starting the Codex app-server turn.

## Output Rules

- Do not paraphrase the refined spec.
- Do not add extra implementation advice before starting the implementation.
- If the bridge fails, report the exact command failure briefly and do not invent a refined spec.
- If the bridge reports a partial spec from a timeout, do not implement it.
