import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildAuthoritativeContext,
  buildRefinementInstruction,
  DEFAULT_CONTEXT_MODEL,
  DEFAULT_MODEL,
  formatHookOutput,
  parseArgs,
  parseRevisePayload,
  runAppServerTurn,
  runCodexRefinement,
  shouldSkipHook,
} from "../scripts/codex-refine-core.mjs";

function createFakeAppServer() {
  const writes = [];
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

  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      if (line) writes.push(JSON.parse(line));
    }
  });

  return {
    child,
    writes,
    spawnCodex: () => child,
    async startThread() {
      await new Promise((resolve) => setImmediate(resolve));
      child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-1" } } })}\n`);
    },
    async completeTurn(text) {
      await new Promise((resolve) => setImmediate(resolve));
      child.stdout.write(`${JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            phase: "final_answer",
            text,
            type: "agentMessage",
          },
        },
      })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: {} })}\n`);
    },
  };
}

function runCli(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/codex-refine.mjs", ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

test("uses gpt-5.5 as the default Codex model", () => {
  assert.equal(DEFAULT_MODEL, "gpt-5.5");
});

test("uses gpt-5.4-mini as the default context-aware Codex model", () => {
  assert.equal(DEFAULT_CONTEXT_MODEL, "gpt-5.4-mini");
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

test("buildRefinementInstruction in revise mode folds in prior spec, findings, and notes", () => {
  const instruction = buildRefinementInstruction("fix upload retries", {
    mode: "revise",
    priorSpec: "Goal: add retries to uploadWithRetries().",
    claudeFindings: "uploadWithRetries lives in src/uploader.js, not src/upload.js.",
    revisionNotes: "Cap retries at 3 attempts.",
  });

  assert.match(instruction, /You previously produced a spec/);
  assert.match(instruction, /<revision_resolution_policy>/);
  assert.match(instruction, /<structured_output_contract>/);
  assert.match(instruction, /<prior_spec>/);
  assert.match(instruction, /add retries to uploadWithRetries/);
  assert.match(instruction, /<claude_findings>/);
  assert.match(instruction, /src\/uploader\.js/);
  assert.match(instruction, /<revision_notes>/);
  assert.match(instruction, /Cap retries at 3 attempts/);
  assert.match(instruction, /<user_request>/);
  assert.match(instruction, /fix upload retries/);
  assert.doesNotMatch(instruction, /Rewrite the user's request/);
});

test("buildRefinementInstruction in revise mode omits the notes block when notes are empty", () => {
  const instruction = buildRefinementInstruction("fix upload retries", {
    mode: "revise",
    priorSpec: "Goal: add retries.",
    claudeFindings: "Confirmed src/uploader.js.",
    revisionNotes: "",
  });

  assert.match(instruction, /<prior_spec>/);
  assert.match(instruction, /<claude_findings>/);
  assert.doesNotMatch(instruction, /<revision_notes>/);
});

test("buildRefinementInstruction requires explicit revise mode and findings", () => {
  assert.throws(
    () => buildRefinementInstruction("fix upload retries", {
      priorSpec: "Goal: add retries.",
      claudeFindings: "Confirmed src/uploader.js.",
    }),
    /Revise fields require mode: "revise"/,
  );

  assert.throws(
    () => buildRefinementInstruction("fix upload retries", {
      mode: "revise",
      priorSpec: "Goal: add retries.",
      claudeFindings: "",
    }),
    /Revise mode requires claudeFindings/,
  );
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
  });
  assert.deepEqual(parseArgs(["--text", "fix the test"]), {
    hookOutput: "standard",
    mode: "text",
    text: "fix the test",
    withContext: false,
  });
});

test("parseArgs supports context-aware text mode", () => {
  assert.deepEqual(parseArgs(["--with-context", "--text", "fix the test"]), {
    hookOutput: "standard",
    mode: "text",
    text: "fix the test",
    withContext: true,
  });
});

test("parseArgs supports revise mode", () => {
  assert.deepEqual(parseArgs(["--revise"]), {
    hookOutput: "standard",
    mode: "revise",
    text: null,
    withContext: false,
  });
});

test("parseArgs rejects revise mode combined with other input modes", () => {
  assert.throws(() => parseArgs(["--revise", "--with-context"]), /--with-context cannot be combined with --revise/);
  assert.throws(() => parseArgs(["--revise", "--hook"]), /--hook cannot be combined with --revise/);
  assert.throws(() => parseArgs(["--revise", "--text", "fix the test"]), /--text cannot be combined with --revise/);
  assert.throws(() => parseArgs(["--revise", "fix the test"]), /Free-form argv text cannot be combined with --revise/);
});

test("parseRevisePayload splits delimited sections and tolerates missing notes", () => {
  const payload = [
    "<<<REQUEST>>>",
    "fix upload retries",
    "<<<PRIOR_SPEC>>>",
    "Goal: add retries.",
    "<<<FINDINGS>>>",
    "uploadWithRetries is in src/uploader.js.",
    "<<<REVISION_NOTES>>>",
    "Cap retries at 3.",
  ].join("\n");

  assert.deepEqual(parseRevisePayload(payload), {
    request: "fix upload retries",
    priorSpec: "Goal: add retries.",
    findings: "uploadWithRetries is in src/uploader.js.",
    revisionNotes: "Cap retries at 3.",
  });

  const withoutNotes = [
    "<<<REQUEST>>>",
    "fix upload retries",
    "<<<PRIOR_SPEC>>>",
    "Goal: add retries.",
    "<<<FINDINGS>>>",
    "Confirmed src/uploader.js.",
  ].join("\n");

  assert.deepEqual(parseRevisePayload(withoutNotes), {
    request: "fix upload retries",
    priorSpec: "Goal: add retries.",
    findings: "Confirmed src/uploader.js.",
    revisionNotes: "",
  });
});

test("revise CLI rejects payloads without findings before calling Codex", async () => {
  const result = await runCli(["--revise"], [
    "<<<REQUEST>>>",
    "fix upload retries",
    "<<<PRIOR_SPEC>>>",
    "Goal: add retries.",
  ].join("\n"));

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Revise payload is missing a <<<FINDINGS>>> section/);
  assert.equal(result.stdout, "");
});

test("buildAuthoritativeContext frames the refined spec as primary", () => {
  const context = buildAuthoritativeContext("Goal: Fix the failing test.");

  assert.match(context, /authoritative version/);
  assert.match(context, /raw message is secondary/);
  assert.match(context, /Goal: Fix the failing test/);
});

test("runAppServerTurn sends safe app-server turn parameters and returns final agent text", async () => {
  const fakeServer = createFakeAppServer();

  const resultPromise = runAppServerTurn({
    codexBin: "codex",
    cwd: "/tmp/project",
    instruction: "Rewrite this",
    model: "gpt-test",
    spawnCodex: fakeServer.spawnCodex,
    timeoutMs: 1000,
  });

  await fakeServer.startThread();
  await fakeServer.completeTurn("Goal: Rewrite the request.");

  assert.equal(await resultPromise, "Goal: Rewrite the request.");

  const threadStart = fakeServer.writes.find((message) => message.method === "thread/start");
  const turnStart = fakeServer.writes.find((message) => message.method === "turn/start");
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(threadStart.params.sandbox, "read-only");
  assert.equal(turnStart.params.approvalPolicy, "never");
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Rewrite this" }]);
});

test("runCodexRefinement with context sends context-aware instruction with the mini model by default", async () => {
  const fakeServer = createFakeAppServer();

  const resultPromise = runCodexRefinement("fix upload retries", {
    cwd: "/repo",
    mode: "context",
    repositoryContext: [
      "# Repository Context",
      "## Current Git Diff (`git diff --`)",
      "diff --git a/src/upload.js b/src/upload.js",
      "## Relevant Ripgrep Searches",
      "src/upload.js:10:function uploadWithRetries() {}",
    ].join("\n"),
    spawnCodex: fakeServer.spawnCodex,
    timeoutMs: 1000,
  });

  await fakeServer.startThread();
  await fakeServer.completeTurn("Goal: Rewrite the request with context.");

  assert.equal(await resultPromise, "Goal: Rewrite the request with context.");

  const turnStart = fakeServer.writes.find((message) => message.method === "turn/start");
  assert.equal(turnStart.params.model, "gpt-5.4-mini");
  assert.match(turnStart.params.input[0].text, /Turn ASSUMPTIONs into concrete, correct references/);
  assert.match(turnStart.params.input[0].text, /src\/upload\.js/);
});

test("runCodexRefinement in revise mode sends the revise instruction with the flagship model", async () => {
  const fakeServer = createFakeAppServer();

  const resultPromise = runCodexRefinement("fix upload retries", {
    cwd: "/repo",
    mode: "revise",
    priorSpec: "Goal: add retries.",
    claudeFindings: "uploadWithRetries lives in src/uploader.js.",
    revisionNotes: "Cap retries at 3.",
    spawnCodex: fakeServer.spawnCodex,
    timeoutMs: 1000,
  });

  await fakeServer.startThread();
  await fakeServer.completeTurn("Goal: Tightened spec.");

  assert.equal(await resultPromise, "Goal: Tightened spec.");

  const turnStart = fakeServer.writes.find((message) => message.method === "turn/start");
  assert.equal(turnStart.params.model, "gpt-5.5");
  assert.match(turnStart.params.input[0].text, /You previously produced a spec/);
  assert.match(turnStart.params.input[0].text, /src\/uploader\.js/);
  assert.match(turnStart.params.input[0].text, /Cap retries at 3/);
});
