---
name: refine-and-revise
description: Collaboratively refine a rough coding request through two Codex rounds: an initial context-grounded spec, then a tightened spec informed by Claude's repository exploration, with user revisions before running.
disable-model-invocation: true
---

# Refine And Revise

Use this skill when the user explicitly invokes `/codex-advisor:refine-and-revise` or asks to collaboratively refine and revise a request before running it.

Unlike the one-shot skills, this is a loop: Codex drafts a spec, Claude verifies it against the real repository, Codex tightens it using those findings, and the user can keep revising. Do not implement anything until the user accepts a spec.

## Workflow

1. Identify the exact user request to refine. If it is missing or too vague to refine, ask for it.
2. **Pass 1 - Codex draft (context-grounded):** run the bridge with `--with-context` to get an initial spec. Show it exactly as returned.
3. **Plan - Claude explores:** read the files, symbols, commands, and tests the spec references. Verify each `ASSUMPTION` against the actual repository: confirm real paths, correct false ones, and find the right test/build command. Write a compact findings list: concrete facts and corrections only, no prose.
4. **Pass 2 - Codex revise:** run the bridge with `--revise`, feeding the original request, the Pass 1 spec, and your findings. Leave revision notes empty on this first revise pass. Show the tightened spec exactly as returned.
5. **Collaborate:** ask whether the user wants to run it as-is, revise it, or stop.
6. **Revise loop:** if the user gives revision notes, run `--revise` again. Every revise payload still needs all of `REQUEST`, `PRIOR_SPEC`, and `FINDINGS`, so re-paste your findings each round. Refresh them only if the notes send you back to explore more. Set `PRIOR_SPEC` to the latest spec and `REVISION_NOTES` to the user's new notes. Do not accumulate prior specs or stack old notes; carry only the most recent spec plus the new notes. Show the new spec and ask again. Repeat until the user runs or stops.
7. **Run / stop:** on run, implement the accepted spec, treating it as authoritative. If an `ASSUMPTION` still looks wrong, flag it in one line, then proceed. On stop, end without implementing.

## Commands

Pass 1 - initial context-grounded draft (request on stdin so shell quoting cannot change it):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --with-context <<'CODEX_ADVISOR_REQUEST'
<request to refine>
CODEX_ADVISOR_REQUEST
```

Pass 2 and each revise round - a section-delimited payload on stdin. The markers below are literal; `<<<REVISION_NOTES>>>` may be empty or omitted on the first revise pass:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-refine.mjs" --revise <<'CODEX_ADVISOR_REVISE'
<<<REQUEST>>>
<original rough request>
<<<PRIOR_SPEC>>>
<latest spec from the previous Codex round>
<<<FINDINGS>>>
<your verified findings from exploring the repo>
<<<REVISION_NOTES>>>
<user's revision notes, or empty>
CODEX_ADVISOR_REVISE
```

The revise pass uses your findings as the authoritative repository evidence and does not re-run the ripgrep/git gather.

## Output Rules

- Do not paraphrase either spec; show each exactly as the bridge returns it.
- Keep the findings list factual and compact: paths, symbols, commands, corrected `ASSUMPTION`s, and no commentary.
- Do not implement until the user accepts a spec.
- If the bridge fails, report the exact command failure briefly and do not invent a spec.
