# Codex Spec Antipatterns

Common ways a spec goes wrong, and the fix.

## Vague verbs

- **Bad:** "improve", "clean up", "make it better", "handle errors".
- **Why it fails:** the agent has to guess what "better" means and often does too much.
- **Fix:** state the observable change. "Return 429 with a `Retry-After` header when the rate limit is exceeded."

## Unverifiable acceptance criteria

- **Bad:** "the code should be robust" / "performance is acceptable".
- **Why it fails:** nothing to check, so nothing confirms completion.
- **Fix:** tie each criterion to a command, test, or measurable state. "p95 latency under 200ms in `bench/upload.bench.js`."

## Inventing repository facts

- **Bad:** naming `src/services/UploadManager.ts` when you have not confirmed it exists.
- **Why it fails:** the agent acts on a false premise and edits the wrong place.
- **Fix:** only cite paths, symbols, and commands that are given or present in context. Otherwise write `ASSUMPTION: there is an upload module to modify`.

## Scope creep

- **Bad:** a "fix the test" spec that also renames variables, bumps dependencies, and reformats files.
- **Why it fails:** large, risky diffs that are hard to review and easy to get wrong.
- **Fix:** restrict scope explicitly and list what is out of scope. Only include incidental changes when they are required for correctness.

## Assumption soup

- **Bad:** ten `ASSUMPTION:` lines for trivia that does not change the outcome.
- **Why it fails:** buries the assumptions that actually matter.
- **Fix:** only record an assumption when resolving it would change correctness, scope, safety, or verification. Everything else: just pick the low-risk default.

## Restating instead of refining

- **Bad:** the Goal repeats the user's sentence verbatim.
- **Why it fails:** adds no precision; the ambiguity is still there.
- **Fix:** resolve the ambiguity in the Goal. Turn "add retries" into "retry transient upload failures up to 3 times with backoff".

## Burying the lede

- **Bad:** three paragraphs of narrative before the actual requirement.
- **Why it fails:** the agent may act on the framing instead of the requirement.
- **Fix:** lead with the Goal sentence, then list requirements as imperatives. Cut filler.
