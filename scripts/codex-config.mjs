import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Single source of truth for every tunable. With env vars removed, these are the
// values the plugin uses when nothing is set in `.codex/config.toml` or via a
// per-invocation flag.
export const DEFAULTS = Object.freeze({
  model: "gpt-5.5",
  contextModel: "gpt-5.4-mini",
  effort: "low",
  timeoutMs: 90000,
  minChars: 40,
  disable: false,
  codexBin: "codex",
  context: Object.freeze({
    searchTerms: 8,
    fileTreeLines: 250,
    diffChars: 20000,
  }),
});

// Strip an optional surrounding quote, or cut a bare value at its inline `#`
// comment. We support only the simple scalar forms Codex config uses (strings,
// integers, booleans) rather than the full TOML grammar.
function readScalar(rawValue) {
  const value = rawValue.trim();
  const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  const hash = value.indexOf("#");
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

function coerceInt(value, fallback, { min = 0 } = {}) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

function coerceBool(value, fallback) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

// Minimal, dependency-free TOML reader. Returns a map of section name to its
// key/value pairs, where the top-level (pre-table) section is keyed by "".
// Only the scalar forms Codex config uses are understood; arrays and inline
// tables are ignored. This is enough to read `[codex_advisor]` and
// `[codex_advisor.context]` alongside Codex's own top-level `model` keys.
export function parseConfigSections(text) {
  const sections = { "": {} };
  let current = "";
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[\[?\s*([^[\]]+?)\s*\]\]?$/);
    if (header) {
      current = header[1].trim();
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    sections[current][key] = readScalar(line.slice(eq + 1));
  }
  return sections;
}

function readSectionsFile(filePath, readFile) {
  try {
    return parseConfigSections(readFile(filePath, "utf8"));
  } catch {
    // A missing or unreadable config file simply means "no override".
    return {};
  }
}

// Merge user-level and project-level config, with project values overriding
// user values per section, mirroring Codex's own precedence.
function loadMergedSections({ cwd, home, readFile }) {
  const merged = {};
  const userSections = home ? readSectionsFile(path.join(home, ".codex", "config.toml"), readFile) : {};
  const projectSections = readSectionsFile(path.join(cwd, ".codex", "config.toml"), readFile);
  for (const sections of [userSections, projectSections]) {
    for (const [name, kv] of Object.entries(sections)) {
      merged[name] = { ...(merged[name] ?? {}), ...kv };
    }
  }
  return merged;
}

// Resolve the effective settings for a run.
//
// Precedence: per-invocation flag  ->  [codex_advisor] table  ->  Codex's own
// top-level model/effort  ->  built-in default. The only environment variable
// still consulted is CODEX_ADVISOR_DISABLE, a file-free kill switch for the
// optional prompt hook.
export function resolveSettings({
  cwd = process.cwd(),
  home = homedir(),
  env = process.env,
  flags = {},
  readFile = readFileSync,
} = {}) {
  const merged = loadMergedSections({ cwd, home, readFile });
  const top = merged[""] ?? {};
  const advisor = merged.codex_advisor ?? {};
  const context = merged["codex_advisor.context"] ?? {};

  const flagModel = flags.model ?? null;
  const flagEffort = flags.effort ?? null;
  const envDisable = env?.CODEX_ADVISOR_DISABLE === "1" || env?.CODEX_ADVISOR_DISABLE === "true";

  return Object.freeze({
    model: flagModel ?? advisor.model ?? top.model ?? DEFAULTS.model,
    contextModel: flagModel ?? advisor.context_model ?? top.model ?? DEFAULTS.contextModel,
    effort: flagEffort ?? advisor.effort ?? top.model_reasoning_effort ?? DEFAULTS.effort,
    timeoutMs: coerceInt(advisor.timeout_ms, DEFAULTS.timeoutMs, { min: 1 }),
    minChars: coerceInt(advisor.min_chars, DEFAULTS.minChars),
    disable: envDisable || coerceBool(advisor.disable, DEFAULTS.disable),
    codexBin: advisor.codex_bin || DEFAULTS.codexBin,
    context: Object.freeze({
      searchTerms: coerceInt(context.search_terms, DEFAULTS.context.searchTerms),
      fileTreeLines: coerceInt(context.file_tree_lines, DEFAULTS.context.fileTreeLines),
      diffChars: coerceInt(context.diff_chars, DEFAULTS.context.diffChars),
    }),
  });
}
