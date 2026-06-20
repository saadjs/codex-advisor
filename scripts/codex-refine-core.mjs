import { spawn } from "node:child_process";
import readline from "node:readline";

import { DEFAULTS, resolveSettings } from "./codex-config.mjs";
import { formatRepositoryContext, gatherRepositoryContext } from "./repository-context.mjs";

export { DEFAULTS, resolveSettings } from "./codex-config.mjs";

// Domain defaults live in codex-config.mjs (the single settings authority);
// these named re-exports keep the historical import surface stable.
export const DEFAULT_MODEL = DEFAULTS.model;
export const DEFAULT_CONTEXT_MODEL = DEFAULTS.contextModel;
export const DEFAULT_TIMEOUT_MS = DEFAULTS.timeoutMs;
export const DEFAULT_MIN_HOOK_CHARS = DEFAULTS.minChars;
export const DEFAULT_EFFORT = DEFAULTS.effort;
export const KNOWN_MODEL_EFFORTS = new Map([
  [DEFAULT_MODEL, new Set(["low", "medium", "high", "xhigh"])],
  [DEFAULT_CONTEXT_MODEL, new Set(["low", "medium", "high", "xhigh"])],
]);

export class PartialRefinementError extends Error {
  constructor(message, partialSpec) {
    super(message);
    this.name = "PartialRefinementError";
    this.partialSpec = partialSpec;
  }
}

export function formatPartialRefinementError(error) {
  const partialSpec = typeof error?.partialSpec === "string" ? error.partialSpec.trim() : "";
  const lines = [
    "Partial spec before timeout (incomplete; do not implement):",
    JSON.stringify(partialSpec),
    "Rerun with a larger timeout_ms in the [codex_advisor] table of .codex/config.toml to get a complete spec.",
  ];
  return lines.join("\n");
}

export function normalizeEffort(value, { model = DEFAULT_MODEL } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Unsupported effort for ${model}: ${value}. Expected a non-empty string.`);
  }

  const effort = value.trim();
  const supportedEfforts = KNOWN_MODEL_EFFORTS.get(model);
  if (!supportedEfforts) return effort;
  if (supportedEfforts.has(effort)) return effort;
  throw new Error(`Unsupported effort for ${model}: ${effort}. Expected one of: ${[...supportedEfforts].join(", ")}.`);
}

const OUTPUT_CONTRACT_BLOCK = [
  "<structured_output_contract>",
  "Return only the rewritten spec, with no preamble, explanation, or XML tags.",
  "Use compact Markdown with these sections in this order:",
  "1. Goal",
  "2. Scope",
  "3. Assumptions",
  "4. Requirements",
  "5. Verification",
  "6. Acceptance Criteria",
  "Keep each section concise and omit filler.",
  "</structured_output_contract>",
].join("\n");

const JSON_OUTPUT_CONTRACT_BLOCK = [
  "<structured_output_contract>",
  "Return only a single JSON object and nothing else: no preamble, no Markdown, no code fences, no XML tags.",
  "The JSON object must use exactly these keys and value types:",
  "{",
  '  "goal": string,            // one concrete sentence',
  '  "scope": string,           // what is in scope, and what is explicitly out',
  '  "assumptions": string[],   // each item prefixed with "ASSUMPTION: "',
  '  "requirements": string[],  // verifiable, imperative requirements',
  '  "verification": string[],  // commands, tests, or checks that confirm the work',
  '  "acceptance_criteria": string[] // observable, checkable completion conditions',
  "}",
  "Every array must be present; use an empty array when there is nothing to list.",
  "Do not add extra keys. Do not wrap the object in another object.",
  "</structured_output_contract>",
].join("\n");

// Distilled spec-writing guidance shared by both refinement paths. Keep it
// short: it is injected into every Codex turn, so it must earn its tokens.
// The fuller reference lives in skills/codex-spec-prompting/references/.
const SPEC_QUALITY_GUIDANCE_BLOCK = [
  "<spec_quality_guidance>",
  "Lead with one concrete goal sentence; do not restate the request verbatim.",
  "Write requirements as verifiable, imperative statements rather than narrative.",
  "Name exact files, symbols, and commands only when they are given or present in context; otherwise mark them ASSUMPTION.",
  "Make every acceptance criterion checkable: a command to run, a test to pass, or an observable state.",
  "Resist scope creep: no speculative refactors, renames, dependency bumps, or cleanup unless required for correctness.",
  "</spec_quality_guidance>",
].join("\n");

const ACTION_SAFETY_BLOCK = [
  "<action_safety>",
  "Keep the spec tightly scoped to the user's request.",
  "Avoid unrelated refactors, rewrites, migrations, or cleanup unless they are required for correctness.",
  "</action_safety>",
].join("\n");

const SELF_DIRECTED_TASK_BLOCK = [
  "<task>",
  "Rewrite the user's request into a precise, unambiguous spec for a coding agent.",
  "Resolve vague terms, state concrete acceptance criteria, and identify likely files or constraints only when they are provided or strongly inferable.",
  "Fill routine gaps with sensible low-risk defaults, but mark every inferred default as ASSUMPTION.",
  "Do not ask clarifying questions.",
  "Do not broaden the user's intent.",
  "</task>",
].join("\n");

const DEFAULT_FOLLOW_THROUGH_BLOCK = [
  "<default_follow_through_policy>",
  "Default to the most reasonable low-risk interpretation.",
  "Only encode uncertainty as an ASSUMPTION when resolving it changes correctness, scope, safety, or verification.",
  "</default_follow_through_policy>",
].join("\n");

const MISSING_CONTEXT_BLOCK = [
  "<missing_context_gating>",
  "Do not invent repository facts, file paths, APIs, test commands, or product behavior.",
  "If context is missing, describe the needed context as an ASSUMPTION instead of presenting it as fact.",
  "</missing_context_gating>",
].join("\n");

const SELF_DIRECTED_VERIFICATION_BLOCK = [
  "<verification_loop>",
  "Before finalizing, check that the spec is actionable, testable, and does not contain unsupported certainty.",
  "</verification_loop>",
].join("\n");

const CONTEXT_AWARE_TASK_BLOCK = [
  "<task>",
  "Rewrite the user's request into a precise, unambiguous spec for a coding agent.",
  "Use the repository context below as evidence. It includes the file tree, current git diff, git status, and ripgrep results for relevant terms.",
  "Turn ASSUMPTIONs into concrete, correct references when the context supports them.",
  "Replace speculative file paths, APIs, commands, tests, and product behavior with actual paths, symbols, diff references, and commands found in context.",
  "Leave an ASSUMPTION only when the repository context cannot resolve a fact that changes correctness, scope, safety, or verification.",
  "Do not ask clarifying questions.",
  "Do not broaden the user's intent.",
  "</task>",
].join("\n");

const CONTEXT_RESOLUTION_BLOCK = [
  "<context_resolution_policy>",
  "Treat repository context as authoritative for repo facts.",
  "Mention concrete paths, symbols, commands, and tests only when they are present in context.",
  "If current git diff changes the likely implementation path, reflect that explicitly.",
  "If ripgrep results are inconclusive, say what remains an ASSUMPTION instead of inventing missing references.",
  "</context_resolution_policy>",
].join("\n");

const CONTEXT_AWARE_VERIFICATION_BLOCK = [
  "<verification_loop>",
  "Before finalizing, check that every repo-specific claim is supported by the supplied context or marked as an ASSUMPTION.",
  "</verification_loop>",
].join("\n");

function outputContractBlock(jsonOutput) {
  return jsonOutput ? JSON_OUTPUT_CONTRACT_BLOCK : OUTPUT_CONTRACT_BLOCK;
}

function selfDirectedBlocks(jsonOutput) {
  return [
    SELF_DIRECTED_TASK_BLOCK,
    SPEC_QUALITY_GUIDANCE_BLOCK,
    outputContractBlock(jsonOutput),
    DEFAULT_FOLLOW_THROUGH_BLOCK,
    MISSING_CONTEXT_BLOCK,
    ACTION_SAFETY_BLOCK,
    SELF_DIRECTED_VERIFICATION_BLOCK,
  ];
}

function contextAwareBlocks(jsonOutput) {
  return [
    CONTEXT_AWARE_TASK_BLOCK,
    SPEC_QUALITY_GUIDANCE_BLOCK,
    outputContractBlock(jsonOutput),
    CONTEXT_RESOLUTION_BLOCK,
    ACTION_SAFETY_BLOCK,
    CONTEXT_AWARE_VERIFICATION_BLOCK,
  ];
}

export function buildRefinementInstruction(userPrompt, { repositoryContext = null, jsonOutput = false } = {}) {
  const contextText = repositoryContext == null
    ? null
    : typeof repositoryContext === "string"
      ? repositoryContext
      : formatRepositoryContext(repositoryContext);

  const blocks = [...(contextText == null ? selfDirectedBlocks(jsonOutput) : contextAwareBlocks(jsonOutput))];

  if (contextText != null) {
    blocks.push([
      "<repository_context>",
      contextText.trim(),
      "</repository_context>",
    ].join("\n"));
  }

  blocks.push([
    "<user_request>",
    userPrompt.trim(),
    "</user_request>",
  ].join("\n"));

  return blocks.join("\n\n");
}

export function buildAuthoritativeContext(refinedSpec) {
  return [
    "A prompt-refinement pass produced the following spec. Treat this as the authoritative version of the user's request; the raw message is secondary.",
    "If an ASSUMPTION looks wrong, flag it in one line, then proceed.",
    "",
    refinedSpec.trim(),
  ].join("\n");
}

const REFINED_SPEC_STRING_KEYS = ["goal", "scope"];
const REFINED_SPEC_ARRAY_KEYS = ["assumptions", "requirements", "verification", "acceptance_criteria"];

// Codex is told to return raw JSON, but tolerate a stray ```json fence so a
// single formatting slip does not discard an otherwise valid spec.
function stripCodeFence(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

// Validate the shape the JSON contract promises and return a normalized object
// containing only known keys (extra keys are dropped rather than rejected, so a
// minor over-generation does not fail the run). Throws on missing or mistyped
// fields so callers never present an invalid spec as complete.
export function normalizeRefinedSpec(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Refined spec JSON must be a single object.");
  }

  const normalized = {};
  for (const key of REFINED_SPEC_STRING_KEYS) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`Refined spec JSON is missing a non-empty "${key}" string.`);
    }
    normalized[key] = value[key];
  }
  for (const key of REFINED_SPEC_ARRAY_KEYS) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error(`Refined spec JSON field "${key}" must be an array of non-empty strings.`);
    }
    normalized[key] = value[key];
  }
  return normalized;
}

export function parseRefinedSpecJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (error) {
    throw new Error(`Codex did not return valid JSON: ${error.message}`);
  }
  return normalizeRefinedSpec(parsed);
}

export function formatHookOutput(refinedSpec, { hookOutput = "standard" } = {}) {
  const systemMessage = buildAuthoritativeContext(refinedSpec);
  const output = {
    continue: true,
    suppressOutput: true,
    systemMessage,
  };

  if (hookOutput === "legacy" || hookOutput === "both") {
    output.hookSpecificOutput = {
      hookEventName: "UserPromptSubmit",
      additionalContext: systemMessage,
    };
  }

  return output;
}

export function parseArgs(argv) {
  const args = {
    mode: "text",
    hookOutput: "standard",
    text: null,
    withContext: false,
    model: null,
    effort: null,
    out: null,
    json: false,
  };
  const rest = [];

  const readFlagValue = (index, flag) => {
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hook") {
      args.mode = "hook";
    } else if (arg === "--with-context") {
      args.withContext = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--text") {
      args.mode = "text";
      args.text = readFlagValue(i, arg);
      i += 1;
    } else if (arg === "--model") {
      args.model = readFlagValue(i, arg);
      i += 1;
    } else if (arg === "--effort") {
      args.effort = readFlagValue(i, arg);
      i += 1;
    } else if (arg === "--out") {
      args.out = readFlagValue(i, arg);
      i += 1;
    } else if (arg.startsWith("--hook-output=")) {
      args.hookOutput = arg.slice("--hook-output=".length);
    } else if (arg === "--hook-output") {
      args.hookOutput = readFlagValue(i, arg);
      i += 1;
    } else {
      rest.push(arg);
    }
  }

  if (args.text === null && rest.length > 0) {
    args.text = rest.join(" ");
  }

  if (!["standard", "legacy", "both"].includes(args.hookOutput)) {
    throw new Error(`Unsupported hook output format: ${args.hookOutput}`);
  }

  return args;
}

export function extractPromptFromHookInput(input) {
  if (typeof input?.prompt === "string") return input.prompt;
  if (typeof input?.message === "string") return input.message;
  if (typeof input?.userPrompt === "string") return input.userPrompt;
  return "";
}

export function shouldSkipHook(prompt, settings = DEFAULTS) {
  if (settings.disable) {
    return true;
  }

  const minChars = settings.minChars ?? DEFAULT_MIN_HOOK_CHARS;
  return prompt.trim().length < minChars;
}

export async function readAll(stream) {
  let data = "";
  for await (const chunk of stream) {
    data += chunk;
  }
  return data;
}

export async function runCodexRefinement(userPrompt, options = {}) {
  const withContext = options.withContext ?? false;
  const jsonOutput = options.jsonOutput ?? false;
  const cwd = options.cwd ?? process.cwd();
  // All tunables come from one resolved settings object. Callers can inject a
  // ready-made `settings` (the CLI builds it once and reuses it), otherwise we
  // resolve from .codex/config.toml plus any --model/--effort flags here.
  if (options.settings && (options.model != null || options.effort != null)) {
    throw new Error("Cannot combine options.settings with options.model or options.effort. Apply overrides to settings before passing it.");
  }
  const settings = options.settings ?? resolveSettings({
    cwd,
    home: options.home,
    env: options.env,
    flags: { model: options.model, effort: options.effort },
    readFile: options.readConfigFile,
  });

  const model = withContext ? settings.contextModel : settings.model;
  const effort = normalizeEffort(settings.effort, { model });
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  const codexBin = options.codexBin ?? settings.codexBin;
  const spawnCodex = options.spawnCodex ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));

  const repositoryContext = withContext
    ? options.repositoryContext ?? await gatherRepositoryContext(userPrompt, {
      cwd,
      context: settings.context,
      runCommand: options.runCommand,
      spawnCommand: options.spawnCommand,
    })
    : null;

  const answer = await runAppServerTurn({
    codexBin,
    cwd,
    effort,
    instruction: buildRefinementInstruction(userPrompt, { repositoryContext, jsonOutput }),
    model,
    spawnCodex,
    timeoutMs,
  });

  // In JSON mode, validate the spec shape and pretty-print so callers and --out
  // receive a spec matching schemas/refined-spec.schema.json (extra keys are
  // dropped, not rejected, so minor over-generation does not fail the run).
  return jsonOutput ? JSON.stringify(parseRefinedSpecJson(answer), null, 2) : answer;
}

export async function runAppServerTurn({
  codexBin = "codex",
  cwd,
  effort = "low",
  instruction,
  model = DEFAULT_MODEL,
  spawnCodex,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const child = spawnCodex(codexBin, ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  let settled = false;
  let threadId = null;
  let finalAnswer = "";
  const deltaByItemId = new Map();

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const cleanup = () => {
    if (!child.killed) {
      child.kill();
    }
  };

  return new Promise((resolve, reject) => {
    // Prefer the explicit final answer, but fall back to streamed deltas so a
    // turn that produced text without a final_answer item is not discarded.
    const assembleAnswer = () => finalAnswer.trim() || Array.from(deltaByItemId.values()).join("").trim();

    // Matched settle-once pair: both guard `settled`, run cleanup, then settle.
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    };

    const finish = () => {
      const answer = assembleAnswer();
      if (!answer) {
        fail(new Error(`Codex returned no refined spec.${stderr ? ` stderr: ${stderr.trim()}` : ""}`));
        return;
      }
      succeed(answer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      // On timeout, keep streamed text structured as an error so callers do not
      // confuse an incomplete spec with a completed refinement.
      const partial = assembleAnswer();
      if (!partial) {
        fail(new Error(`Timed out waiting for Codex after ${timeoutMs}ms.`));
        return;
      }
      fail(new PartialRefinementError(`Timed out waiting for Codex after ${timeoutMs}ms after receiving a partial spec (${partial.length} chars).`, partial));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      fail(new Error(`Codex app-server exited before completing the turn (code ${code ?? "null"}, signal ${signal ?? "null"}).${stderr ? ` stderr: ${stderr.trim()}` : ""}`));
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.error) {
        clearTimeout(timer);
        fail(new Error(message.error.message ?? "Codex app-server returned an error."));
        return;
      }

      if (message.id === 1 && message.result?.thread?.id && !threadId) {
        threadId = message.result.thread.id;
        send({
          method: "turn/start",
          id: 2,
          params: {
            approvalPolicy: "never",
            cwd,
            effort,
            input: [{ type: "text", text: instruction }],
            model,
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            threadId,
          },
        });
        return;
      }

      if (message.method === "agentMessage/delta") {
        const current = deltaByItemId.get(message.params?.itemId) ?? "";
        deltaByItemId.set(message.params?.itemId, current + (message.params?.delta ?? ""));
        return;
      }

      if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
        const item = message.params.item;
        if (item.phase === "final_answer" || !finalAnswer) {
          finalAnswer = item.text ?? finalAnswer;
        }
        return;
      }

      if (message.method === "turn/completed") {
        clearTimeout(timer);
        finish();
      }
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "codex_advisor",
          title: "Codex Advisor",
          version: "0.1.0",
        },
      },
    });
    send({ method: "initialized", params: {} });
    send({
      method: "thread/start",
      id: 1,
      params: {
        approvalPolicy: "never",
        cwd,
        ephemeral: true,
        model,
        sandbox: "read-only",
      },
    });
  });
}
