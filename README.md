# Codex Advisor

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Codex app-server](https://img.shields.io/badge/Codex-app--server-111827)](https://developers.openai.com/codex/app-server)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](package.json)
[![GitHub last commit](https://img.shields.io/github/last-commit/saadjs/codex-advisor)](https://github.com/saadjs/codex-advisor/commits/main)

Codex Advisor is a Claude Code plugin that asks `codex app-server` to rewrite a rough request into a precise coding-agent spec.

The default path is the `refine` skill. That keeps the user in the loop before Claude acts on the rewritten prompt and avoids adding a Codex round trip to every message.

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

Then run:

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
CODEX_ADVISOR_MODEL=gpt-5.5
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
