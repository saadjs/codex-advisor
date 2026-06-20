import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { DEFAULTS, parseConfigSections, resolveSettings } from "../scripts/codex-config.mjs";

const noConfig = () => {
  const error = new Error("ENOENT");
  error.code = "ENOENT";
  throw error;
};

test("parseConfigSections reads top-level keys and named tables", () => {
  const toml = [
    'model = "gpt-5.5"',
    "model_reasoning_effort = 'low'   # inline comment",
    "",
    "[codex_advisor]",
    'context_model = "gpt-5.4-mini"',
    "timeout_ms = 90000",
    "disable = true",
    "",
    "[codex_advisor.context]",
    "search_terms = 8",
  ].join("\n");

  const sections = parseConfigSections(toml);
  assert.equal(sections[""].model, "gpt-5.5");
  assert.equal(sections[""].model_reasoning_effort, "low");
  assert.equal(sections.codex_advisor.context_model, "gpt-5.4-mini");
  assert.equal(sections.codex_advisor.timeout_ms, "90000");
  assert.equal(sections.codex_advisor.disable, "true");
  assert.equal(sections["codex_advisor.context"].search_terms, "8");
});

test("parseConfigSections tolerates empty and null input", () => {
  assert.deepEqual(parseConfigSections(""), { "": {} });
  assert.deepEqual(parseConfigSections(null), { "": {} });
});

test("resolveSettings returns built-in defaults when no config exists", () => {
  const settings = resolveSettings({ cwd: "/repo", home: "/home/u", env: {}, readFile: noConfig });
  assert.equal(settings.model, DEFAULTS.model);
  assert.equal(settings.contextModel, DEFAULTS.contextModel);
  assert.equal(settings.effort, DEFAULTS.effort);
  assert.equal(settings.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(settings.minChars, DEFAULTS.minChars);
  assert.equal(settings.disable, false);
  assert.equal(settings.codexBin, DEFAULTS.codexBin);
  assert.deepEqual(settings.context, DEFAULTS.context);
});

test("resolveSettings reads the [codex_advisor] table and coerces types", () => {
  const toml = [
    "[codex_advisor]",
    'context_model = "gpt-x"',
    "timeout_ms = 1234",
    "min_chars = 5",
    "disable = true",
    'codex_bin = "/usr/bin/codex"',
    "[codex_advisor.context]",
    "search_terms = 3",
    "file_tree_lines = 9",
    "diff_chars = 100",
  ].join("\n");

  const settings = resolveSettings({ cwd: "/repo", home: "/home/u", env: {}, readFile: () => toml });
  assert.equal(settings.contextModel, "gpt-x");
  assert.equal(settings.timeoutMs, 1234);
  assert.equal(settings.minChars, 5);
  assert.equal(settings.disable, true);
  assert.equal(settings.codexBin, "/usr/bin/codex");
  assert.deepEqual(settings.context, { searchTerms: 3, fileTreeLines: 9, diffChars: 100 });
});

test("resolveSettings precedence: flag > [codex_advisor] > top-level > default", () => {
  const layered = ['model = "gpt-top"', "[codex_advisor]", 'model = "gpt-adv"'].join("\n");

  assert.equal(resolveSettings({ env: {}, readFile: () => layered, flags: { model: "gpt-flag" } }).model, "gpt-flag");
  assert.equal(resolveSettings({ env: {}, readFile: () => layered }).model, "gpt-adv");
  assert.equal(resolveSettings({ env: {}, readFile: () => 'model = "gpt-top"' }).model, "gpt-top");
  assert.equal(resolveSettings({ env: {}, readFile: noConfig }).model, DEFAULTS.model);
});

test("resolveSettings merges project config over user config, keeping unset user keys", () => {
  const home = "/home/u";
  const cwd = "/repo";
  const files = new Map([
    [path.join(home, ".codex", "config.toml"), '[codex_advisor]\ncontext_model = "user-model"\nmin_chars = 99\n'],
    [path.join(cwd, ".codex", "config.toml"), '[codex_advisor]\ncontext_model = "project-model"\n'],
  ]);
  const readFile = (filePath) => {
    if (!files.has(filePath)) throw new Error("ENOENT");
    return files.get(filePath);
  };

  const settings = resolveSettings({ cwd, home, env: {}, readFile });
  assert.equal(settings.contextModel, "project-model");
  assert.equal(settings.minChars, 99);
});

test("resolveSettings honors CODEX_ADVISOR_DISABLE as a file-free kill switch", () => {
  assert.equal(resolveSettings({ env: { CODEX_ADVISOR_DISABLE: "1" }, readFile: noConfig }).disable, true);
  assert.equal(resolveSettings({ env: { CODEX_ADVISOR_DISABLE: "true" }, readFile: noConfig }).disable, true);
  assert.equal(resolveSettings({ env: {}, readFile: noConfig }).disable, false);
});

test("resolveSettings falls back to defaults for invalid numeric config", () => {
  const settings = resolveSettings({ env: {}, readFile: () => '[codex_advisor]\ntimeout_ms = "abc"\n' });
  assert.equal(settings.timeoutMs, DEFAULTS.timeoutMs);
});
