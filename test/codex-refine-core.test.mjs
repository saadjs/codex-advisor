import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildAuthoritativeContext,
  buildRefinementInstruction,
  formatHookOutput,
  parseArgs,
  runAppServerTurn,
  shouldSkipHook,
} from "../scripts/codex-refine-core.mjs";

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
  });
  assert.deepEqual(parseArgs(["--text", "fix the test"]), {
    hookOutput: "standard",
    mode: "text",
    text: "fix the test",
  });
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
