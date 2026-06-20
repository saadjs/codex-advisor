#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

import {
  extractPromptFromHookInput,
  formatPartialRefinementError,
  formatHookOutput,
  parseArgs,
  PartialRefinementError,
  readAll,
  resolveSettings,
  runCodexRefinement,
  shouldSkipHook,
} from "./codex-refine-core.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const flags = { model: args.model, effort: args.effort };

  if (args.mode === "hook") {
    const input = JSON.parse(await readAll(process.stdin));
    const prompt = extractPromptFromHookInput(input);
    const cwd = input.cwd ?? process.cwd();
    const settings = resolveSettings({ cwd, flags });
    if (shouldSkipHook(prompt, settings)) {
      return;
    }

    const refinedSpec = await runCodexRefinement(prompt, {
      cwd,
      withContext: args.withContext,
      jsonOutput: args.json,
      settings,
    });
    process.stdout.write(JSON.stringify(formatHookOutput(refinedSpec, { hookOutput: args.hookOutput })));
    return;
  }

  const prompt = args.text ?? (await readAll(process.stdin));
  if (!prompt.trim()) {
    throw new Error("Provide a prompt with --text or stdin.");
  }

  const settings = resolveSettings({ cwd: process.cwd(), flags });
  const refinedSpec = await runCodexRefinement(prompt, {
    withContext: args.withContext,
    jsonOutput: args.json,
    settings,
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
    process.stderr.write(`${formatPartialRefinementError(error)}\n`);
  }
  process.exit(1);
});
