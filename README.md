# Codex Advisor

Codex Advisor is a Claude Code plugin that asks `codex app-server` to rewrite a rough request into a precise coding-agent spec.

The default path is the `refine` skill. That keeps the user in the loop before Claude acts on the rewritten prompt and avoids adding a Codex round trip to every message.

## Layout

```text
.claude-plugin/plugin.json
skills/refine/SKILL.md
hooks/hooks.example.json
scripts/codex-refine.mjs
scripts/codex-refine-core.mjs
test/codex-refine-core.test.mjs
```

## Usage

Install this folder as a Claude Code plugin, then run:

```text
Use the refine skill to refine this request: add retry logic to the uploader
```

The skill runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs"
```

with the request on stdin. It prints a rewritten spec and asks whether to run it, revise it, or stop.

## Optional Hook

`hooks/hooks.example.json` contains an optional `UserPromptSubmit` hook. Rename or copy it to `hooks/hooks.json` only if you want automatic prompt refinement on every sufficiently long prompt.

Current Claude Code hook docs describe `systemMessage` as the standard way to pass context from `UserPromptSubmit`. The script uses that by default. If you need the older `hookSpecificOutput.additionalContext` shape from earlier examples, pass:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --hook --hook-output=both
```

Useful environment variables:

```bash
CODEX_ADVISOR_MODEL=gpt-5.4
CODEX_ADVISOR_TIMEOUT_MS=90000
CODEX_ADVISOR_MIN_CHARS=40
CODEX_ADVISOR_DISABLE=1
CODEX_ADVISOR_CODEX_BIN=codex
```

The Codex turn is started with `approvalPolicy: "never"` and a read-only sandbox policy so the refinement pass cannot request interactive approvals or make changes.

## Development

```bash
npm test
```
