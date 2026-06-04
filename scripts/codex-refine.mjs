#!/usr/bin/env node
import {
  extractPromptFromHookInput,
  formatHookOutput,
  parseArgs,
  readAll,
  runCodexRefinement,
  shouldSkipHook,
} from "./codex-refine-core.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "hook") {
    const input = JSON.parse(await readAll(process.stdin));
    const prompt = extractPromptFromHookInput(input);
    if (shouldSkipHook(prompt)) {
      return;
    }

    const refinedSpec = await runCodexRefinement(prompt, {
      cwd: input.cwd ?? process.cwd(),
      withContext: args.withContext,
    });
    process.stdout.write(JSON.stringify(formatHookOutput(refinedSpec, { hookOutput: args.hookOutput })));
    return;
  }

  const prompt = args.text ?? (await readAll(process.stdin));
  if (!prompt.trim()) {
    throw new Error("Provide a prompt with --text or stdin.");
  }

  const refinedSpec = await runCodexRefinement(prompt, { withContext: args.withContext });
  process.stdout.write(`${refinedSpec.trim()}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
