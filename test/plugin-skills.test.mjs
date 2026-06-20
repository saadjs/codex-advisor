import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("README codex-advisor commands have matching manual-only skills", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const skillNames = new Set(
    [...readme.matchAll(/\/codex-advisor:([a-z-]+)/g)].map((match) => match[1]),
  );

  assert.deepEqual([...skillNames].sort(), ["refine", "refine-and-run", "refine-with-context"]);

  for (const skillName of skillNames) {
    const skill = await readFile(new URL(`../skills/${skillName}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, new RegExp(`name: ${skillName}`));
    assert.match(skill, /disable-model-invocation: true/);
  }
});

test("codex-spec-prompting is a model-invocable reference skill with references", async () => {
  const skill = await readFile(new URL("../skills/codex-spec-prompting/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /name: codex-spec-prompting/);
  // A reference skill should stay model-invocable so Claude can consult it.
  assert.doesNotMatch(skill, /disable-model-invocation: true/);

  for (const reference of ["codex-spec-recipes.md", "codex-spec-antipatterns.md"]) {
    const contents = await readFile(
      new URL(`../skills/codex-spec-prompting/references/${reference}`, import.meta.url),
      "utf8",
    );
    assert.ok(contents.trim().length > 0, `${reference} should not be empty`);
  }
});
