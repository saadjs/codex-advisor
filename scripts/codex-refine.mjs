#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import {
  extractPromptFromHookInput,
  formatHookOutput,
  parseArgs,
  PartialRefinementError,
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
      model: args.model,
      effort: args.effort,
    });
    process.stdout.write(JSON.stringify(formatHookOutput(refinedSpec, { hookOutput: args.hookOutput })));
    return;
  }

  const prompt = args.text ?? (await readAll(process.stdin));
  if (!prompt.trim()) {
    throw new Error("Provide a prompt with --text or stdin.");
  }

  const refinedSpec = await runCodexRefinement(prompt, {
    withContext: args.withContext,
    model: args.model,
    effort: args.effort,
  });
  const spec = `${refinedSpec.trim()}\n`;
  // Emit to stdout first so a bad --out path can't discard the just-computed spec.
  process.stdout.write(spec);
  if (args.out) {
    await writeFile(args.out, spec);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  if (error instanceof PartialRefinementError) {
    process.stderr.write("Partial spec was discarded; rerun with a longer CODEX_ADVISOR_TIMEOUT_MS to get a complete spec.\n");
  }
  process.exit(1);
});
