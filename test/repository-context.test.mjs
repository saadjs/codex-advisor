import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  gatherRepositoryContext,
  runProcessCapture,
} from "../scripts/repository-context.mjs";

test("gatherRepositoryContext inspects file tree, git diff, and relevant ripgrep matches", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ args, command });
    const joined = `${command} ${args.join(" ")}`;

    if (joined === "git rev-parse --show-toplevel") {
      return { code: 0, stderr: "", stdout: "/repo\n" };
    }
    if (joined === "git status --short") {
      return { code: 0, stderr: "", stdout: " M scripts/codex-refine-core.mjs\n" };
    }
    if (joined === "git diff --stat") {
      return { code: 0, stderr: "", stdout: " scripts/codex-refine-core.mjs | 10 +++++-----\n" };
    }
    if (joined === "git diff --") {
      return { code: 0, stderr: "", stdout: "diff --git a/scripts/codex-refine-core.mjs b/scripts/codex-refine-core.mjs\n" };
    }
    if (command === "rg" && args[0] === "--files") {
      return { code: 0, stderr: "", stdout: "scripts/codex-refine-core.mjs\nskills/refine/SKILL.md\n" };
    }
    if (command === "rg" && args.includes("upload")) {
      return { code: 0, stderr: "", stdout: "src/upload.js:10:function uploadWithRetries() {}\n" };
    }

    return { code: 1, stderr: "", stdout: "" };
  };

  const context = await gatherRepositoryContext("fix upload retries", {
    cwd: "/repo",
    runCommand,
  });

  assert.equal(context.repoRoot, "/repo");
  assert.equal(context.fileTreeSource, "rg --files");
  assert.match(context.gitStatus, /scripts\/codex-refine-core\.mjs/);
  assert.match(context.gitDiff, /diff --git/);
  assert.match(context.fileTree, /skills\/refine\/SKILL\.md/);
  assert.equal(context.searches.length, 1);
  assert.match(context.searches[0].output, /uploadWithRetries/);
  assert.ok(calls.some((call) => call.command === "rg" && call.args[0] === "--files"));
  assert.ok(calls.some((call) => call.command === "git" && call.args.join(" ") === "diff --"));
  assert.ok(calls.some((call) => call.command === "rg" && call.args.includes("upload")));
});

test("gatherRepositoryContext falls back to git ls-files when ripgrep is unavailable", async () => {
  const runCommand = async (command, args) => {
    const joined = `${command} ${args.join(" ")}`;
    if (joined === "git rev-parse --show-toplevel") return { code: 0, stderr: "", stdout: "/repo\n" };
    if (command === "rg" && args[0] === "--files") return { code: 127, stderr: "rg: not found", stdout: "" };
    if (joined === "git ls-files") return { code: 0, stderr: "", stdout: "README.md\npackage.json\n" };
    return { code: 1, stderr: "", stdout: "" };
  };

  const context = await gatherRepositoryContext("update readme", { cwd: "/repo", runCommand });

  assert.equal(context.fileTreeSource, "git ls-files");
  assert.match(context.fileTree, /package\.json/);
});

test("runProcessCapture caps output at maxChars and reports the true overflow once", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handlers = {};
  const fakeChild = {
    killed: false,
    stdout,
    stderr,
    kill() {
      this.killed = true;
    },
    once(event, handler) {
      handlers[event] = handler;
      return this;
    },
  };

  const resultPromise = runProcessCapture("rg", ["big"], {
    maxChars: 10,
    spawnCommand: () => fakeChild,
    timeoutMs: 1000,
  });

  await new Promise((resolve) => setImmediate(resolve));
  fakeChild.stdout.write("0123456789ABCDE"); // 15 chars
  fakeChild.stdout.write("FGHIJ"); // +5 => 20 chars total
  await new Promise((resolve) => setImmediate(resolve));
  handlers.exit(0, null);

  const result = await resultPromise;
  assert.equal(result.code, 0);
  // Kept exactly maxChars, then a single accurate note for the 10 dropped chars.
  assert.equal(result.stdout, "0123456789\n[truncated 10 chars]");
});
