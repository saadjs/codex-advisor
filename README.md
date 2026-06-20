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

## Configuration

All tunables live in the same `.codex/config.toml` file Codex itself uses. Put user-level defaults in `~/.codex/config.toml` and project overrides in `<cwd>/.codex/config.toml`.

```toml
# Shared with Codex itself
model = "gpt-5.5"
model_reasoning_effort = "low"

[codex_advisor]
context_model = "gpt-5.4-mini"
timeout_ms = 90000
min_chars = 40
disable = false
codex_bin = "codex"

[codex_advisor.context]
search_terms = 8
file_tree_lines = 250
diff_chars = 20000
```

Every key is optional. Omit any and it falls back to the default shown above.

- `model` / `model_reasoning_effort` at the top level are Codex's own keys; the advisor reads them as defaults.
- `[codex_advisor]` holds advisor-specific settings. `context_model` is used for `--with-context` runs; `model` here overrides the top-level model for advisor runs only.
- `[codex_advisor.context]` tunes the bounded repository context collected for `--with-context`: `search_terms` (ripgrep term count), `file_tree_lines` (file-tree line cap), and `diff_chars` (character budget for `git diff`).
- `disable = true` turns off the optional `UserPromptSubmit` hook (see [Optional Hook](#optional-hook)).
- The only environment variable still consulted is `CODEX_ADVISOR_DISABLE=1` (or `true`), a file-free kill switch for the same hook.

Effective values resolve with this precedence:

```text
per-invocation flag  →  [codex_advisor] table  →  Codex top-level model/effort  →  built-in default
```

So a project that already pins `model = "gpt-5.4-mini"` in `.codex/config.toml` is respected without re-specifying it, while an explicit `--model` still wins for a single run.

## JSON output

Pass `--json` to emit a structured spec instead of Markdown:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --json <<'CODEX_ADVISOR_REQUEST'
add retry logic to the uploader
CODEX_ADVISOR_REQUEST
```

The bridge validates the shape of the returned JSON against [`schemas/refined-spec.schema.json`](schemas/refined-spec.schema.json) (`goal`, `scope`, `assumptions[]`, `requirements[]`, `verification[]`, `acceptance_criteria[]`), pretty-prints it, and fails with a clear error rather than emitting an invalid or partial object. Extra keys are dropped rather than rejected, so minor over-generation does not fail the run. `--json` works with `--with-context` and `--out`, and is independent of hook mode.

## Spec-writing reference

The plugin bundles a `codex-spec-prompting` skill under `skills/codex-spec-prompting/` with `references/` recipes and antipatterns for writing precise coding-agent specs. It documents the same six-section standard (Goal, Scope, Assumptions, Requirements, Verification, Acceptance Criteria) the bridge applies, so Claude can consult it when hand-writing or judging a spec. Unlike the `refine*` commands, it is model-invocable.

The bridge also accepts per-invocation flags: `--model <name>` and `--effort <level>` override the model and reasoning effort for a single run, `--out <file>` writes the refined spec to a file in addition to stdout, and `--json` returns a validated structured spec (see [JSON output](#json-output)).

The Codex turn is started with `approvalPolicy: "never"` and a read-only sandbox policy so the refinement pass cannot request interactive approvals or make changes.

## Development

```bash
npm test
```
