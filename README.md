# Codex Advisor

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Codex app-server](https://img.shields.io/badge/Codex-app--server-111827)](https://developers.openai.com/codex/app-server)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](package.json)
[![GitHub last commit](https://img.shields.io/github/last-commit/saadjs/codex-advisor)](https://github.com/saadjs/codex-advisor/commits/main)

Codex Advisor is a Claude Code plugin that asks `codex app-server` to rewrite a rough request into a precise coding-agent spec.

The default path is the `refine` command. All three skills are manually invoked only (`disable-model-invocation: true`) — Claude never triggers them on its own. That keeps the user in the loop before Claude acts on the rewritten prompt and avoids adding a Codex round trip to every message.

The `refine-with-context` command adds a repo-inspection pass first: file tree, current git status and diff, and ripgrep matches for likely relevant terms. It uses `gpt-5.4-mini` by default for a faster context-aware refinement pass.

## Usage

Install from GitHub:

```bash
claude plugin marketplace add saadjs/codex-advisor
claude plugin install codex-advisor@codex-advisor
```

Or load a local checkout for development:

```bash
claude --plugin-dir /path/to/codex-advisor
```

Then invoke the command:

```text
/codex-advisor:refine add retry logic to the uploader
```

The skill runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs"
```

with the request on stdin. It prints a rewritten spec and asks whether to run it, revise it, or stop.

For a context-aware refinement pass, invoke the command:

```text
/codex-advisor:refine-with-context add retry logic to the uploader
```

It runs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --with-context <<'CODEX_ADVISOR_REQUEST'
add retry logic to the uploader
CODEX_ADVISOR_REQUEST
```

The bridge reads bounded repository context before starting the Codex turn, then asks Codex to replace speculative `ASSUMPTION`s with concrete file paths, symbols, commands, tests, and current-diff references where the context supports them.

To refine with context and run the result automatically — without the confirmation stop — invoke:

```text
/codex-advisor:refine-and-run add retry logic to the uploader
```

It performs the same context-aware refinement as `refine-with-context`, prints the spec for the record, and then implements it in the same turn instead of asking whether to run, revise, or stop.

## Optional Hook

`hooks/hooks.example.json` contains an optional `UserPromptSubmit` hook. Rename or copy it to `hooks/hooks.json` only if you want automatic prompt refinement on every sufficiently long prompt.

Current Claude Code hook docs describe `systemMessage` as the standard way to pass context from `UserPromptSubmit`. The script uses that by default. If you need the older `hookSpecificOutput.additionalContext` shape from earlier examples, pass:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --hook --hook-output=both
```

Useful environment variables:

```bash
CODEX_ADVISOR_MODEL=gpt-5.5
CODEX_ADVISOR_CONTEXT_MODEL=gpt-5.4-mini
CODEX_ADVISOR_EFFORT=low
CODEX_ADVISOR_TIMEOUT_MS=90000
CODEX_ADVISOR_MIN_CHARS=40
CODEX_ADVISOR_DISABLE=1
CODEX_ADVISOR_CODEX_BIN=codex
```

`CODEX_ADVISOR_EFFORT` sets the Codex reasoning effort. Accepted values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` (default `low`). An unrecognized value fails fast rather than being passed through.

The Codex turn is started with `approvalPolicy: "never"` and a read-only sandbox policy so the refinement pass cannot request interactive approvals or make changes.

## Development

```bash
npm test
```
