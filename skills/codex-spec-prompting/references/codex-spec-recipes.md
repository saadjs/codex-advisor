# Codex Spec Recipes

Worked patterns for precise specs. Each shows the rough request, then the
refined spec in the six-section structure.

## Recipe: bug fix

**Rough:** "the uploader keeps failing, fix it"

**Refined:**

- **Goal:** Make the file uploader recover from transient network errors instead of failing the whole upload.
- **Scope:** Retry logic in the upload path only. Out of scope: the chunking format, auth, and the progress UI.
- **Assumptions:**
  - ASSUMPTION: "keeps failing" refers to transient 5xx / network errors, not validation failures.
  - ASSUMPTION: retries should be bounded so a permanently-down server does not hang the upload.
- **Requirements:**
  - Retry a failed upload request up to 3 times.
  - Use exponential backoff with jitter between attempts.
  - Do not retry on 4xx responses; surface those to the caller unchanged.
- **Verification:** `npm test -- upload`; add a test that a 503 then 200 sequence succeeds and a 400 fails fast.
- **Acceptance Criteria:** A simulated transient failure results in a successful upload; a 400 fails on the first attempt with the original error.

## Recipe: small feature

**Rough:** "add a --json flag"

**Refined:**

- **Goal:** Add a `--json` flag that emits the command's result as a single JSON object instead of human text.
- **Scope:** Output formatting and flag parsing. Out of scope: changing what data is computed.
- **Assumptions:**
  - ASSUMPTION: existing text output stays the default; `--json` is opt-in.
- **Requirements:**
  - Parse `--json` in the argument parser with a boolean default of false.
  - When set, serialize the result object with a stable key order and exit 0.
  - On error, still exit non-zero; do not print a partial JSON object.
- **Verification:** unit test for the parser; a test asserting `--json` output parses and matches the expected shape.
- **Acceptance Criteria:** `cmd --json | jq .` succeeds; omitting the flag preserves the current text output byte-for-byte.

## Recipe: refactor (only when asked)

**Rough:** "clean up the config code"

**Refined:**

- **Goal:** Extract config resolution into one function so model/effort precedence is defined in a single place.
- **Scope:** Move existing precedence logic; behavior must not change. Out of scope: adding new config keys or defaults.
- **Assumptions:**
  - ASSUMPTION: current precedence (flag > env > file > default) is correct and must be preserved exactly.
- **Requirements:**
  - Introduce one resolver that returns the effective model and effort.
  - Replace inline lookups with calls to the resolver.
- **Verification:** existing tests pass unchanged; add a test pinning the precedence order.
- **Acceptance Criteria:** No observable behavior change; the precedence order is covered by a test.

## Quick structure to reuse

```
Goal: <one sentence>
Scope: <in scope> / Out: <out of scope>
Assumptions:
- ASSUMPTION: <inferred default that affects correctness/scope/safety/verification>
Requirements:
- <verifiable imperative>
Verification:
- <command or test>
Acceptance Criteria:
- <observable, checkable condition>
```
