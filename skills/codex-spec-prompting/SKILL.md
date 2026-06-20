---
name: codex-spec-prompting
description: Reference recipes and antipatterns for writing precise Codex coding-agent specs. Use when refining, reviewing, or hand-writing a spec for Codex or another coding agent, or when judging whether a refined spec is good enough to run.
---

# Codex Spec Prompting

Guidance for turning a rough request into a precise, runnable spec for a coding
agent. This is the same standard the Codex Advisor bridge applies when it
rewrites a request — use it when you write or review a spec yourself, or when
deciding whether a refined spec is ready to execute.

## A good spec has six parts

1. **Goal** — one concrete sentence. What changes and why, not a restatement of the request.
2. **Scope** — what is in scope, and explicitly what is out. This is where you stop scope creep.
3. **Assumptions** — every inferred default, each prefixed with `ASSUMPTION:`. Only list one when resolving it would change correctness, scope, safety, or verification.
4. **Requirements** — verifiable, imperative statements. "Retry failed uploads up to 3 times with exponential backoff", not "make uploads more reliable".
5. **Verification** — the exact commands, tests, or checks that confirm the work.
6. **Acceptance Criteria** — observable, checkable completion conditions.

## How to apply it

- Name exact files, symbols, and commands **only** when they are given or present in repository context. Otherwise mark them `ASSUMPTION:` rather than inventing them.
- Prefer one precise requirement over three vague ones.
- Make every acceptance criterion something you could check: a command to run, a test to pass, or an observable state to inspect.
- Keep the spec tightly scoped. No speculative refactors, renames, dependency bumps, or cleanup unless they are required for correctness.

## References

- `references/codex-spec-recipes.md` — worked structures and before/after examples.
- `references/codex-spec-antipatterns.md` — common failure modes and how to fix them.
