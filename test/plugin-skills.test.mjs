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
