import { spawn } from "node:child_process";

export const DEFAULT_CONTEXT_COMMAND_TIMEOUT_MS = 5000;

const DEFAULT_CONTEXT_FILE_TREE_LINES = 250;
const DEFAULT_CONTEXT_OUTPUT_CHARS = 12000;
const DEFAULT_CONTEXT_DIFF_CHARS = 20000;
const DEFAULT_CONTEXT_SEARCH_CHARS = 12000;
const DEFAULT_CONTEXT_SEARCH_LINES = 80;
const DEFAULT_CONTEXT_SEARCH_TERMS = 8;
const STDERR_CAPTURE_CHARS = 1200;

const RG_CONTEXT_GLOBS = [
  "!.git/**",
  "!node_modules/**",
  "!dist/**",
  "!build/**",
  "!coverage/**",
  "!.next/**",
];

const SEARCH_STOP_WORDS = new Set([
  "add",
  "and",
  "are",
  "bug",
  "but",
  "can",
  "fix",
  "for",
  "from",
  "into",
  "make",
  "need",
  "needs",
  "new",
  "not",
  "please",
  "request",
  "should",
  "that",
  "the",
  "then",
  "this",
  "turn",
  "use",
  "used",
  "user",
  "using",
  "want",
  "when",
  "with",
]);

// Resolve an integer budget from an explicit option, then a settings override,
// falling back to the constant. Invalid and below-minimum candidates are skipped.
export function intOption(option, settingsValue, fallback, { min = 0 } = {}) {
  for (const candidate of [option, settingsValue]) {
    const raw = typeof candidate === "string" ? candidate.trim() : candidate;
    if (raw == null || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= min) return parsed;
  }
  return fallback;
}

export function truncateText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

export function limitLines(text, maxLines) {
  const parsedLimit = Number(maxLines);
  const limit = Number.isInteger(parsedLimit) ? Math.max(0, parsedLimit) : DEFAULT_CONTEXT_FILE_TREE_LINES;
  const lines = String(text ?? "").split("\n");
  if (lines.length <= limit) return lines.join("\n");
  const kept = lines.slice(0, limit).join("\n");
  const truncated = `[truncated ${lines.length - limit} lines]`;
  return kept ? `${kept}\n${truncated}` : truncated;
}

export function deriveSearchTerms(userPrompt, { maxTerms = DEFAULT_CONTEXT_SEARCH_TERMS } = {}) {
  const parsedLimit = Number(maxTerms);
  const limit = Number.isInteger(parsedLimit) ? Math.max(0, parsedLimit) : DEFAULT_CONTEXT_SEARCH_TERMS;
  if (limit === 0) return [];

  const seen = new Set();
  const terms = [];
  const candidates = userPrompt.match(/[A-Za-z0-9][A-Za-z0-9_./:-]{2,}/g) ?? [];

  for (const candidate of candidates) {
    const term = candidate.replace(/^[./:-]+|[./:-]+$/g, "");
    const key = term.toLowerCase();

    if (!term || term.length < 3 || SEARCH_STOP_WORDS.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    terms.push(term);

    if (terms.length >= limit) {
      break;
    }
  }

  return terms;
}

export async function runProcessCapture(command, args, {
  cwd = process.cwd(),
  maxChars = DEFAULT_CONTEXT_OUTPUT_CHARS,
  spawnCommand = spawn,
  timeoutMs = DEFAULT_CONTEXT_COMMAND_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const out = { text: "", total: 0 };
    const err = { text: "", total: 0 };

    // Bound memory by capping each buffer at maxChars while tracking the true
    // total, so the truncation note reports the real overflow exactly once.
    const collect = (buffer, chunk) => {
      const text = String(chunk);
      buffer.total += text.length;
      if (buffer.text.length < maxChars) {
        buffer.text = (buffer.text + text).slice(0, maxChars);
      }
    };
    const finalize = (buffer) => buffer.total > buffer.text.length
      ? `${buffer.text}\n[truncated ${buffer.total - buffer.text.length} chars]`
      : buffer.text;

    const cleanup = () => {
      if (!child.killed) {
        child.kill();
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => collect(out, chunk));
    child.stderr?.on("data", (chunk) => collect(err, chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stderr: finalize(err),
        stdout: finalize(out),
      });
    });
  });
}

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

async function captureContextCommand(runCommand, command, args, options) {
  try {
    const result = await runCommand(command, args, options);
    return {
      code: result?.code ?? 0,
      command: commandLabel(command, args),
      signal: result?.signal ?? null,
      stderr: truncateText(result?.stderr ?? "", STDERR_CAPTURE_CHARS),
      stdout: result?.stdout ?? "",
    };
  } catch (error) {
    return {
      code: null,
      command: commandLabel(command, args),
      signal: null,
      stderr: error.message,
      stdout: "",
    };
  }
}

function formatCommandOutput(result, emptyText) {
  const stdout = result.stdout.trim();
  if (result.code === 0) {
    return stdout || emptyText;
  }

  const problem = result.stderr.trim() || (result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`);
  return stdout || `Unavailable (${problem})`;
}

function contextGlobArgs() {
  return RG_CONTEXT_GLOBS.flatMap((glob) => ["--glob", glob]);
}

async function gatherFileTree(run, cwd) {
  const rgResult = await run("rg", ["--files", "--hidden", ...contextGlobArgs()], {
    cwd,
    maxChars: DEFAULT_CONTEXT_OUTPUT_CHARS,
  });
  if (rgResult.code === 0 || rgResult.stdout.trim()) {
    return { source: "rg --files", result: rgResult };
  }

  const gitResult = await run("git", ["ls-files"], { cwd, maxChars: DEFAULT_CONTEXT_OUTPUT_CHARS });
  return { source: "git ls-files", result: gitResult };
}

async function searchTerm(run, cwd, term) {
  const result = await run("rg", [
    "-n",
    "--hidden",
    "--ignore-case",
    "--fixed-strings",
    "--context",
    "1",
    ...contextGlobArgs(),
    "--",
    term,
  ], {
    cwd,
    maxChars: DEFAULT_CONTEXT_SEARCH_CHARS,
  });
  const output = result.stdout.trim();

  if (result.code === 0 && output) {
    return { match: { command: result.command, output: limitLines(output, DEFAULT_CONTEXT_SEARCH_LINES), term } };
  }
  // ripgrep exit code 1 just means "no matches"; anything else is a real failure.
  if (result.code !== 0 && result.code !== 1) {
    return { failure: { command: result.command, error: result.stderr.trim() || `exit code ${result.code ?? "unknown"}`, term } };
  }
  return {};
}

export async function gatherRepositoryContext(userPrompt, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  // Budgets arrive as a resolved `context` object (from settings); fall back to
  // the built-in defaults when a caller invokes this directly without one.
  const budgets = options.context ?? {};
  const maxSearchTerms = intOption(options.maxSearchTerms, budgets.searchTerms, DEFAULT_CONTEXT_SEARCH_TERMS);
  const fileTreeLines = intOption(options.fileTreeLines, budgets.fileTreeLines, DEFAULT_CONTEXT_FILE_TREE_LINES);
  const diffChars = intOption(options.diffChars, budgets.diffChars, DEFAULT_CONTEXT_DIFF_CHARS);
  const spawnCommand = options.spawnCommand ?? spawn;
  const runCommand = options.runCommand ?? ((command, args, runOptions) => runProcessCapture(command, args, {
    ...runOptions,
    spawnCommand,
  }));
  const run = (command, args, runOptions = {}) => captureContextCommand(runCommand, command, args, {
    cwd: runOptions.cwd ?? cwd,
    maxChars: runOptions.maxChars ?? DEFAULT_CONTEXT_OUTPUT_CHARS,
    timeoutMs: runOptions.timeoutMs ?? DEFAULT_CONTEXT_COMMAND_TIMEOUT_MS,
  });

  const repoRootResult = await run("git", ["rev-parse", "--show-toplevel"], { maxChars: 1000 });
  const repoRoot = repoRootResult.code === 0 ? repoRootResult.stdout.trim().split("\n")[0] : "";
  const contextCwd = repoRoot || cwd;

  const searchTerms = deriveSearchTerms(userPrompt, {
    maxTerms: maxSearchTerms,
  });

  // Every probe below is independent once the repo root is known, so run them
  // concurrently — each command keeps its own timeout — instead of serializing.
  const [gitStatusResult, gitDiffStatResult, gitDiffResult, fileTree, searchResults] = await Promise.all([
    run("git", ["status", "--short"], { cwd: contextCwd, maxChars: 4000 }),
    // Diff against HEAD so staged edits are included, not just unstaged ones.
    run("git", ["diff", "HEAD", "--stat"], { cwd: contextCwd, maxChars: 4000 }),
    run("git", ["diff", "HEAD", "--"], { cwd: contextCwd, maxChars: diffChars }),
    gatherFileTree(run, contextCwd),
    Promise.all(searchTerms.map((term) => searchTerm(run, contextCwd, term))),
  ]);

  const searches = [];
  const searchFailures = [];
  for (const { match, failure } of searchResults) {
    if (match) searches.push(match);
    else if (failure) searchFailures.push(failure);
  }

  return {
    cwd,
    fileTree: limitLines(formatCommandOutput(fileTree.result, "(no files found)"), fileTreeLines),
    fileTreeSource: fileTree.source,
    gitDiff: formatCommandOutput(gitDiffResult, "(no current git diff)"),
    gitDiffStat: formatCommandOutput(gitDiffStatResult, "(no current git diff stat)"),
    gitStatus: formatCommandOutput(gitStatusResult, "(clean working tree)"),
    repoRoot,
    searchCwd: contextCwd,
    searchFailures,
    searchTerms,
    searches,
  };
}

export function formatRepositoryContext(context) {
  const searchText = context.searches.length > 0
    ? context.searches.map((search) => [
      `### Term: ${search.term}`,
      `Command: ${search.command}`,
      search.output,
    ].join("\n")).join("\n\n")
    : `No ripgrep matches found for derived terms: ${context.searchTerms.join(", ") || "(none)"}`;

  const failureText = context.searchFailures.length > 0
    ? `\n\n## Ripgrep Failures\n${context.searchFailures.map((failure) => `${failure.command}: ${failure.error}`).join("\n")}`
    : "";

  return [
    "# Repository Context",
    "",
    "## Workspace",
    `cwd: ${context.cwd}`,
    `repo root: ${context.repoRoot || "(unavailable)"}`,
    `search cwd: ${context.searchCwd}`,
    "",
    "## Git Status (`git status --short`)",
    context.gitStatus,
    "",
    "## Current Git Diff Stat (`git diff HEAD --stat`)",
    context.gitDiffStat,
    "",
    "## Current Git Diff (`git diff HEAD`, staged + unstaged)",
    context.gitDiff,
    "",
    `## File Tree (${context.fileTreeSource})`,
    context.fileTree,
    "",
    "## Relevant Ripgrep Searches",
    `Terms searched: ${context.searchTerms.join(", ") || "(none)"}`,
    "",
    searchText,
    failureText,
  ].join("\n");
}
