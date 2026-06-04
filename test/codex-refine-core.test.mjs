import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildAuthoritativeContext,
  buildRefinementInstruction,
  DEFAULT_CONTEXT_MODEL,
  DEFAULT_MODEL,
  formatPartialRefinementError,
  formatHookOutput,
  normalizeEffort,
  parseArgs,
  PartialRefinementError,
  runAppServerTurn,
  runCodexRefinement,
  shouldSkipHook,
} from "../scripts/codex-refine-core.mjs";

test("uses gpt-5.5 as the default Codex model", () => {
  assert.equal(DEFAULT_MODEL, "gpt-5.5");
});

test("uses gpt-5.4-mini as the default context-aware Codex model", () => {
  assert.equal(DEFAULT_CONTEXT_MODEL, "gpt-5.4-mini");
});

test("normalizeEffort validates known model efforts and passes custom model efforts through", () => {
  assert.equal(normalizeEffort("low"), "low");
  assert.equal(normalizeEffort("xhigh"), "xhigh");
  assert.throws(() => normalizeEffort("turbo"), /Unsupported effort for gpt-5\.5: turbo/);
  assert.throws(() => normalizeEffort(undefined), /Expected a non-empty string/);
  assert.throws(() => normalizeEffort("", { model: "custom-model" }), /Expected a non-empty string/);
  assert.equal(normalizeEffort("turbo", { model: "custom-model" }), "turbo");
});

test("buildRefinementInstruction asks Codex to rewrite instead of clarify", () => {
  const instruction = buildRefinementInstruction("fix upload retries");

  assert.match(instruction, /<task>/);
  assert.match(instruction, /<structured_output_contract>/);
  assert.match(instruction, /<missing_context_gating>/);
  assert.match(instruction, /<verification_loop>/);
  assert.match(instruction, /Rewrite the user's request/);
  assert.match(instruction, /Do not ask clarifying questions/);
  assert.match(instruction, /ASSUMPTION/);
  assert.match(instruction, /fix upload retries/);
  assert.match(instruction, /Return only the rewritten spec/);
  // The self-directed path must not leak the context-aware framing.
  assert.doesNotMatch(instruction, /<repository_context>/);
});

test("buildRefinementInstruction with repositoryContext resolves assumptions from repo context", () => {
  const instruction = buildRefinementInstruction("fix upload retries", {
    repositoryContext: [
      "# Repository Context",
      "## Current Git Diff (`git diff --`)",
      "diff --git a/src/upload.js b/src/upload.js",
      "## Relevant Ripgrep Searches",
      "src/upload.js:10:function uploadWithRetries() {}",
    ].join("\n"),
  });

  assert.match(instruction, /file tree, current git diff, git status, and ripgrep results/);
  assert.match(instruction, /Turn ASSUMPTIONs into concrete, correct references/);
  assert.match(instruction, /Leave an ASSUMPTION only when/);
  assert.match(instruction, /<repository_context>/);
  assert.match(instruction, /src\/upload\.js/);
  assert.match(instruction, /fix upload retries/);
});

test("formatHookOutput uses current Claude Code systemMessage output by default", () => {
  const output = formatHookOutput("Goal: Add retry logic.");

  assert.equal(output.continue, true);
  assert.equal(output.suppressOutput, true);
  assert.match(output.systemMessage, /authoritative version/);
  assert.match(output.systemMessage, /Goal: Add retry logic/);
  assert.equal(output.hookSpecificOutput, undefined);
});

test("formatHookOutput can include legacy additionalContext compatibility", () => {
  const output = formatHookOutput("Goal: Add retry logic.", { hookOutput: "both" });

  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(output.hookSpecificOutput.additionalContext, output.systemMessage);
});

test("hook mode skips trivial prompts by default", () => {
  assert.equal(shouldSkipHook("short"), true);
  assert.equal(shouldSkipHook("write a regression test for the retry behavior", { CODEX_ADVISOR_MIN_CHARS: "10" }), false);
  assert.equal(shouldSkipHook("write a regression test", { CODEX_ADVISOR_DISABLE: "1" }), true);
});

test("parseArgs supports hook output format options", () => {
  assert.deepEqual(parseArgs(["--hook", "--hook-output=both"]), {
    hookOutput: "both",
    mode: "hook",
    text: null,
    withContext: false,
    model: null,
    effort: null,
    out: null,
  });
  assert.deepEqual(parseArgs(["--text", "fix the test"]), {
    hookOutput: "standard",
    mode: "text",
    text: "fix the test",
    withContext: false,
    model: null,
    effort: null,
    out: null,
  });
});

test("parseArgs supports context-aware text mode", () => {
  assert.deepEqual(parseArgs(["--with-context", "--text", "fix the test"]), {
    hookOutput: "standard",
    mode: "text",
    text: "fix the test",
    withContext: true,
    model: null,
    effort: null,
    out: null,
  });
});

test("parseArgs supports --model and --effort overrides", () => {
  assert.deepEqual(parseArgs(["--model", "gpt-x", "--effort", "high", "--text", "hi"]), {
    hookOutput: "standard",
    mode: "text",
    text: "hi",
    withContext: false,
    model: "gpt-x",
    effort: "high",
    out: null,
  });
});

test("parseArgs supports --out for persisting the refined spec", () => {
  assert.deepEqual(parseArgs(["--out", "spec.md", "--text", "hi"]), {
    hookOutput: "standard",
    mode: "text",
    text: "hi",
    withContext: false,
    model: null,
    effort: null,
    out: "spec.md",
  });
});

test("parseArgs rejects missing values before consuming the next flag", () => {
  for (const flag of ["--text", "--model", "--effort", "--out", "--hook-output"]) {
    assert.throws(() => parseArgs([flag]), new RegExp(`Missing value for ${flag}`));
    assert.throws(() => parseArgs([flag, "--with-context", "hi"]), new RegExp(`Missing value for ${flag}`));
  }
});

test("formatPartialRefinementError emits a safe structured partial spec", () => {
  const error = new PartialRefinementError("timeout", "Goal: partial\nScope: incomplete");
  const output = formatPartialRefinementError(error);

  assert.match(output, /incomplete; do not implement/);
  assert.match(output, /"Goal: partial\\nScope: incomplete"/);
  assert.match(output, /CODEX_ADVISOR_TIMEOUT_MS/);
});

test("buildAuthoritativeContext frames the refined spec as primary", () => {
  const context = buildAuthoritativeContext("Goal: Fix the failing test.");

  assert.match(context, /authoritative version/);
  assert.match(context, /raw message is secondary/);
  assert.match(context, /Goal: Fix the failing test/);
});

test("runAppServerTurn sends safe app-server turn parameters and returns final agent text", async () => {
  const writes = [];
  const fakeChild = {
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
    },
    once(event, handler) {
      this[`on_${event}`] = handler;
      return this;
    },
  };
  fakeChild.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (line) writes.push(JSON.parse(line));
    }
  });

  const resultPromise = runAppServerTurn({
    codexBin: "codex",
    cwd: "/tmp/project",
    instruction: "Rewrite this",
    model: "gpt-test",
    spawnCodex: () => fakeChild,
    timeoutMs: 1000,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
  fakeChild.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-1" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        phase: "final_answer",
        text: "Goal: Rewrite the request.",
        type: "agentMessage",
      },
    },
  })}\n`);
  fakeChild.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {} })}\n`);

  assert.equal(await resultPromise, "Goal: Rewrite the request.");

  const threadStart = writes.find((message) => message.method === "thread/start");
  const turnStart = writes.find((message) => message.method === "turn/start");
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(threadStart.params.sandbox, "read-only");
  assert.equal(turnStart.params.approvalPolicy, "never");
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Rewrite this" }]);
});

function makeFakeChild() {
  const child = {
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
    },
    once(event, handler) {
      this[`on_${event}`] = handler;
      return this;
    },
  };
  return child;
}

test("runAppServerTurn rejects with a structured partial spec when the turn times out", async () => {
  const fakeChild = makeFakeChild();

  const resultPromise = runAppServerTurn({
    cwd: "/tmp/project",
    instruction: "Rewrite this",
    spawnCodex: () => fakeChild,
    timeoutMs: 50,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-1" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  // Stream partial deltas, then never send turn/completed so the timer fires.
  fakeChild.stdout.write(`${JSON.stringify({ method: "agentMessage/delta", params: { itemId: "a", delta: "Goal: " } })}\n`);
  fakeChild.stdout.write(`${JSON.stringify({ method: "agentMessage/delta", params: { itemId: "a", delta: "salvage me." } })}\n`);

  await assert.rejects(resultPromise, (error) => {
    assert.ok(error instanceof PartialRefinementError);
    assert.equal(error.partialSpec, "Goal: salvage me.");
    assert.match(error.message, /Timed out waiting for Codex after 50ms/);
    return true;
  });
  assert.equal(fakeChild.killed, true);
});

test("runAppServerTurn still rejects on timeout when nothing was streamed", async () => {
  const fakeChild = makeFakeChild();

  const resultPromise = runAppServerTurn({
    cwd: "/tmp/project",
    instruction: "Rewrite this",
    spawnCodex: () => fakeChild,
    timeoutMs: 50,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-1" } } })}\n`);

  await assert.rejects(resultPromise, /Timed out waiting for Codex after 50ms/);
});

test("runCodexRefinement with context sends context-aware instruction with the mini model by default", async () => {
  const writes = [];
  const fakeChild = {
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
    },
    once(event, handler) {
      this[`on_${event}`] = handler;
      return this;
    },
  };
  fakeChild.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (line) writes.push(JSON.parse(line));
    }
  });

  const resultPromise = runCodexRefinement("fix upload retries", {
    cwd: "/repo",
    withContext: true,
    repositoryContext: [
      "# Repository Context",
      "## Current Git Diff (`git diff --`)",
      "diff --git a/src/upload.js b/src/upload.js",
      "## Relevant Ripgrep Searches",
      "src/upload.js:10:function uploadWithRetries() {}",
    ].join("\n"),
    spawnCodex: () => fakeChild,
    timeoutMs: 1000,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
  fakeChild.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-1" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        phase: "final_answer",
        text: "Goal: Rewrite the request with context.",
        type: "agentMessage",
      },
    },
  })}\n`);
  fakeChild.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {} })}\n`);

  assert.equal(await resultPromise, "Goal: Rewrite the request with context.");

  const turnStart = writes.find((message) => message.method === "turn/start");
  assert.equal(turnStart.params.model, "gpt-5.4-mini");
  assert.match(turnStart.params.input[0].text, /Turn ASSUMPTIONs into concrete, correct references/);
  assert.match(turnStart.params.input[0].text, /src\/upload\.js/);
});
