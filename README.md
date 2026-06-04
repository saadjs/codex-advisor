# Codex Advisor

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Codex app-server](https://img.shields.io/badge/Codex-app--server-111827)](https://developers.openai.com/codex/app-server)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](package.json)
[![GitHub last commit](https://img.shields.io/github/last-commit/saadjs/codex-advisor)](https://github.com/saadjs/codex-advisor/commits/main)

Codex Advisor is a Claude Code plugin that asks `codex app-server` to rewrite a rough request into a precise coding-agent spec.

The default path is the `refine` command. All skills are manually invoked only (`disable-model-invocation: true`) so Claude never triggers them on its own. That keeps the user in the loop before Claude acts on the rewritten prompt and avoids adding a Codex round trip to every message.

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

Then run:

```text
Use the refine skill to refine this request: add retry logic to the uploader
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

For a collaborative loop instead of a one-shot pass, invoke:

```text
/codex-advisor:refine-and-revise add retry logic to the uploader
```

This runs two Codex rounds with a Claude verification step between them:

1. **Pass 1** - a context-grounded draft spec (`codex-refine.mjs --with-context`, default `gpt-5.4-mini`).
2. **Claude explores** - reads the files and symbols the spec references, then verifies each `ASSUMPTION` against the repository.
3. **Pass 2** - Codex tightens the spec using Claude's findings (`codex-refine.mjs --revise`, default `gpt-5.5`).
4. **Revise** - you can hand back revision notes, which loop into another `--revise` round until you run or stop.

The revise round takes a section-delimited payload on stdin so shell quoting cannot mangle the multi-line spec, findings, or notes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --revise <<'CODEX_ADVISOR_REVISE'
<<<REQUEST>>>
add retry logic to the uploader
<<<PRIOR_SPEC>>>
<latest spec from the previous round>
<<<FINDINGS>>>
<Claude's verified findings from exploring the repo>
<<<REVISION_NOTES>>>
<your revision notes, or empty on the first revise pass>
CODEX_ADVISOR_REVISE
```

The revise pass treats Claude's findings as the authoritative repository evidence and does not re-run the ripgrep/git gather. Like the other skills, it is manual-only and never implements until you accept a spec.

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
