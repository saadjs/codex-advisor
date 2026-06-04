import { spawn } from "node:child_process";
import readline from "node:readline";

import { formatRepositoryContext, gatherRepositoryContext } from "./repository-context.mjs";

export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_CONTEXT_MODEL = "gpt-5.4-mini";
export const DEFAULT_TIMEOUT_MS = 90000;
export const DEFAULT_MIN_HOOK_CHARS = 40;

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

const ACTION_SAFETY_BLOCK = [
  "<action_safety>",
  "Keep the spec tightly scoped to the user's request.",
  "Avoid unrelated refactors, rewrites, migrations, or cleanup unless they are required for correctness.",
  "</action_safety>",
].join("\n");

const SELF_DIRECTED_BLOCKS = [
  [
    "<task>",
    "Rewrite the user's request into a precise, unambiguous spec for a coding agent.",
    "Resolve vague terms, state concrete acceptance criteria, and identify likely files or constraints only when they are provided or strongly inferable.",
    "Fill routine gaps with sensible low-risk defaults, but mark every inferred default as ASSUMPTION.",
    "Do not ask clarifying questions.",
    "Do not broaden the user's intent.",
    "</task>",
  ].join("\n"),
  OUTPUT_CONTRACT_BLOCK,
  [
    "<default_follow_through_policy>",
    "Default to the most reasonable low-risk interpretation.",
    "Only encode uncertainty as an ASSUMPTION when resolving it changes correctness, scope, safety, or verification.",
    "</default_follow_through_policy>",
  ].join("\n"),
  [
    "<missing_context_gating>",
    "Do not invent repository facts, file paths, APIs, test commands, or product behavior.",
    "If context is missing, describe the needed context as an ASSUMPTION instead of presenting it as fact.",
    "</missing_context_gating>",
  ].join("\n"),
  ACTION_SAFETY_BLOCK,
  [
    "<verification_loop>",
    "Before finalizing, check that the spec is actionable, testable, and does not contain unsupported certainty.",
    "</verification_loop>",
  ].join("\n"),
];

const REVISE_BLOCKS = [
  [
    "<task>",
    "You previously produced a spec for the user's request. The coding agent has since explored the repository and reported verified findings, and the user may have requested revisions.",
    "Produce an updated, tightened spec for a coding agent.",
    "Promote ASSUMPTIONs that the findings resolve into concrete, correct facts (real file paths, symbols, commands, tests).",
    "Apply the user's revision notes precisely.",
    "Do not ask clarifying questions.",
    "Do not broaden the user's intent.",
    "</task>",
  ].join("\n"),
  OUTPUT_CONTRACT_BLOCK,
  [
    "<revision_resolution_policy>",
    "Treat the coding agent's findings as authoritative for repository facts.",
    "When a finding contradicts the prior spec, correct the spec to match the finding.",
    "Keep an ASSUMPTION only when neither the findings nor any supplied context resolves a fact that changes correctness, scope, safety, or verification.",
    "Preserve parts of the prior spec that the findings and revision notes do not touch.",
    "</revision_resolution_policy>",
  ].join("\n"),
  ACTION_SAFETY_BLOCK,
  [
    "<verification_loop>",
    "Before finalizing, confirm every revision note is reflected and no fact the findings resolved is still left as an ASSUMPTION.",
    "</verification_loop>",
  ].join("\n"),
];

const CONTEXT_AWARE_BLOCKS = [
  [
    "<task>",
    "Rewrite the user's request into a precise, unambiguous spec for a coding agent.",
    "Use the repository context below as evidence. It includes the file tree, current git diff, git status, and ripgrep results for relevant terms.",
    "Turn ASSUMPTIONs into concrete, correct references when the context supports them.",
    "Replace speculative file paths, APIs, commands, tests, and product behavior with actual paths, symbols, diff references, and commands found in context.",
    "Leave an ASSUMPTION only when the repository context cannot resolve a fact that changes correctness, scope, safety, or verification.",
    "Do not ask clarifying questions.",
    "Do not broaden the user's intent.",
    "</task>",
  ].join("\n"),
  OUTPUT_CONTRACT_BLOCK,
  [
    "<context_resolution_policy>",
    "Treat repository context as authoritative for repo facts.",
    "Mention concrete paths, symbols, commands, and tests only when they are present in context.",
    "If current git diff changes the likely implementation path, reflect that explicitly.",
    "If ripgrep results are inconclusive, say what remains an ASSUMPTION instead of inventing missing references.",
    "</context_resolution_policy>",
  ].join("\n"),
  ACTION_SAFETY_BLOCK,
  [
    "<verification_loop>",
    "Before finalizing, check that every repo-specific claim is supported by the supplied context or marked as an ASSUMPTION.",
    "</verification_loop>",
  ].join("\n"),
];

const VALID_REFINEMENT_MODES = new Set(["text", "context", "revise"]);

function assertKnownRefinementMode(mode) {
  if (!VALID_REFINEMENT_MODES.has(mode)) {
    throw new Error(`Unsupported refinement mode: ${mode}`);
  }
}

function normalizeOptionalBlockText(value) {
  return String(value ?? "").trim();
}

function requireBlockText(value, errorMessage) {
  const text = normalizeOptionalBlockText(value);
  if (!text) {
    throw new Error(errorMessage);
  }
  return text;
}

function formatInstructionBlock(tag, value) {
  return [
    `<${tag}>`,
    value,
    `</${tag}>`,
  ].join("\n");
}

function formatContextText(repositoryContext) {
  if (repositoryContext == null) return null;
  return typeof repositoryContext === "string"
    ? repositoryContext
    : formatRepositoryContext(repositoryContext);
}

export function buildRefinementInstruction(userPrompt, {
  mode = null,
  repositoryContext = null,
  priorSpec = null,
  claudeFindings = null,
  revisionNotes = null,
} = {}) {
  const resolvedMode = mode ?? (repositoryContext == null ? "text" : "context");
  assertKnownRefinementMode(resolvedMode);
  const hasReviseInput = [priorSpec, claudeFindings, revisionNotes].some((value) => normalizeOptionalBlockText(value));
  if (resolvedMode !== "revise" && hasReviseInput) {
    throw new Error('Revise fields require mode: "revise".');
  }

  const blocks = resolvedMode === "revise"
    ? [...REVISE_BLOCKS]
    : resolvedMode === "context" ? [...CONTEXT_AWARE_BLOCKS] : [...SELF_DIRECTED_BLOCKS];

  if (resolvedMode === "context") {
    const contextText = requireBlockText(formatContextText(repositoryContext), "Context mode requires repositoryContext.");
    blocks.push(formatInstructionBlock("repository_context", contextText));
  }

  if (resolvedMode === "revise") {
    blocks.push(formatInstructionBlock("prior_spec", requireBlockText(priorSpec, "Revise mode requires priorSpec.")));
    blocks.push(formatInstructionBlock("claude_findings", requireBlockText(claudeFindings, "Revise mode requires claudeFindings.")));

    const notesText = normalizeOptionalBlockText(revisionNotes);
    if (notesText) {
      blocks.push(formatInstructionBlock("revision_notes", notesText));
    }
  }

  blocks.push(formatInstructionBlock("user_request", userPrompt.trim()));

  return blocks.join("\n\n");
}

const REVISE_PAYLOAD_SECTIONS = [
  ["request", "<<<REQUEST>>>"],
  ["priorSpec", "<<<PRIOR_SPEC>>>"],
  ["findings", "<<<FINDINGS>>>"],
  ["revisionNotes", "<<<REVISION_NOTES>>>"],
];

// Parse the section-delimited stdin payload used by --revise. Sections are
// addressed by their literal markers, and absent sections yield empty strings.
export function parseRevisePayload(stdin) {
  const text = String(stdin ?? "");
  const present = REVISE_PAYLOAD_SECTIONS
    .map(([key, marker]) => ({ key, marker, index: text.indexOf(marker) }))
    .filter((section) => section.index !== -1)
    .sort((a, b) => a.index - b.index);

  const result = { request: "", priorSpec: "", findings: "", revisionNotes: "" };
  for (let i = 0; i < present.length; i += 1) {
    const { key, marker, index } = present[i];
    const start = index + marker.length;
    const end = i + 1 < present.length ? present[i + 1].index : text.length;
    result[key] = text.slice(start, end).trim();
  }
  return result;
}

export function buildAuthoritativeContext(refinedSpec) {
  return [
    "A prompt-refinement pass produced the following spec. Treat this as the authoritative version of the user's request; the raw message is secondary.",
    "If an ASSUMPTION looks wrong, flag it in one line, then proceed.",
    "",
    refinedSpec.trim(),
  ].join("\n");
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
  };
  const rest = [];
  let sawRevise = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hook") {
      if (sawRevise) {
        throw new Error("--hook cannot be combined with --revise.");
      }
      args.mode = "hook";
    } else if (arg === "--with-context") {
      args.withContext = true;
    } else if (arg === "--revise") {
      if (args.mode !== "text") {
        throw new Error("--revise cannot be combined with --hook or --text.");
      }
      sawRevise = true;
      args.mode = "revise";
    } else if (arg === "--text") {
      if (sawRevise) {
        throw new Error("--text cannot be combined with --revise.");
      }
      args.mode = "text";
      args.text = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--hook-output=")) {
      args.hookOutput = arg.slice("--hook-output=".length);
    } else if (arg === "--hook-output") {
      args.hookOutput = argv[i + 1] ?? "standard";
      i += 1;
    } else {
      rest.push(arg);
    }
  }

  if (sawRevise && args.text !== null) {
    throw new Error("--text cannot be combined with --revise.");
  }

  if (args.text === null && rest.length > 0) {
    if (sawRevise) {
      throw new Error("Free-form argv text cannot be combined with --revise.");
    }
    args.text = rest.join(" ");
  }

  if (sawRevise && args.withContext) {
    throw new Error("--with-context cannot be combined with --revise.");
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

export function shouldSkipHook(prompt, env = process.env) {
  if (env.CODEX_ADVISOR_DISABLE === "1" || env.CODEX_ADVISOR_DISABLE === "true") {
    return true;
  }

  const minChars = Number.parseInt(env.CODEX_ADVISOR_MIN_CHARS ?? `${DEFAULT_MIN_HOOK_CHARS}`, 10);
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
  const env = options.env ?? process.env;
  const withContext = options.withContext ?? false;
  const mode = options.mode ?? (withContext ? "context" : "text");
  assertKnownRefinementMode(mode);
  const priorSpec = options.priorSpec ?? null;
  const claudeFindings = options.claudeFindings ?? null;
  const revisionNotes = options.revisionNotes ?? null;
  const model = options.model ?? (mode === "revise"
    ? env.CODEX_ADVISOR_MODEL ?? DEFAULT_MODEL
    : mode === "context"
      ? env.CODEX_ADVISOR_CONTEXT_MODEL ?? env.CODEX_ADVISOR_MODEL ?? DEFAULT_CONTEXT_MODEL
      : env.CODEX_ADVISOR_MODEL ?? DEFAULT_MODEL);
  const timeoutMs = options.timeoutMs ?? Number.parseInt(env.CODEX_ADVISOR_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`, 10);
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? env.CODEX_ADVISOR_EFFORT ?? "low";
  const codexBin = options.codexBin ?? env.CODEX_ADVISOR_CODEX_BIN ?? "codex";
  const spawnCodex = options.spawnCodex ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));

  const repositoryContext = mode === "context"
    ? options.repositoryContext ?? await gatherRepositoryContext(userPrompt, {
      cwd,
      runCommand: options.runCommand,
      spawnCommand: options.spawnCommand,
    })
    : null;

  return runAppServerTurn({
    codexBin,
    cwd,
    effort,
    instruction: buildRefinementInstruction(userPrompt, {
      mode,
      repositoryContext,
      priorSpec,
      claudeFindings,
      revisionNotes,
    }),
    model,
    spawnCodex,
    timeoutMs,
  });
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
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const answer = finalAnswer.trim();
      if (!answer) {
        reject(new Error(`Codex returned no refined spec.${stderr ? ` stderr: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(answer);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for Codex after ${timeoutMs}ms.`));
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
        if (!finalAnswer && deltaByItemId.size > 0) {
          finalAnswer = Array.from(deltaByItemId.values()).join("");
        }
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
