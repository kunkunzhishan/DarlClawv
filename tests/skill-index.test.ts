import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkillIndex } from "../src/registry/skill-index.js";

test("loadSkillIndex parses recommended sources and trust fields", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "mydarl-skill-index-"));
  await mkdir(path.join(configRoot, "skills"), { recursive: true });
  await writeFile(
    path.join(configRoot, "skills", "index.yaml"),
    `version: 1
updated_at: "2026-03-01T00:00:00.000Z"
recommended_sources:
  - id: openai-skills-github
    kind: skill
    url: https://github.com/openai/skills
    domain: github.com
    trust_tier: certified
    enabled: true
skills:
  mcp-recovery:
    status: active
    trust_tier: certified
    source_ref: openai-skills-github
    popularity:
      uses: 10
      success_rate: 0.8
    repair_role: repair
`,
    "utf8"
  );

  const doc = await loadSkillIndex(configRoot);
  assert.equal(doc.data.recommended_sources.length, 1);
  assert.equal(doc.data.recommended_sources[0]?.id, "openai-skills-github");
  assert.equal(doc.data.skills["mcp-recovery"]?.repair_role, "repair");
});
