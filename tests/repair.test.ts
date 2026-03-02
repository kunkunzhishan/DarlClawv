import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRepairPriorityLayer,
  isInstallIntentTask,
  sortSkillsByTrustAndPopularity,
  validateSkillSourceRef
} from "../src/core/repair/index.js";
import type { Skill } from "../src/types/contracts.js";

function makeSkill(id: string, args?: Partial<Skill["meta"]>): Skill {
  return {
    id,
    path: `/tmp/${id}/SKILL.md`,
    body: `# ${id}`,
    meta: {
      name: id,
      description: `${id} description`,
      protocol: "codex-skill-v1",
      trigger: {},
      inject_mode: "prepend",
      ...args
    }
  };
}

test("isInstallIntentTask detects install intent keywords", () => {
  assert.equal(isInstallIntentTask("please install and configure this tool"), true);
  assert.equal(isInstallIntentTask("just explain code"), false);
});

test("classifyRepairPriorityLayer prefers certified/popular first", () => {
  const layer = classifyRepairPriorityLayer([
    makeSkill("repair-standard", { trust_tier: "standard", repair_role: "repair" }),
    makeSkill("repair-certified", { trust_tier: "certified", repair_role: "repair" }),
    makeSkill("repair-popular", { trust_tier: "popular", repair_role: "repair" })
  ]);

  assert.equal(layer.layer, "certified-popular");
  assert.deepEqual(layer.selectedSkillIds, ["repair-certified", "repair-popular"]);
});

test("validateSkillSourceRef rejects unknown sources", () => {
  const allowed = [
    {
      id: "openai-skills",
      kind: "skill" as const,
      url: "https://github.com/openai/skills",
      domain: "github.com",
      trust_tier: "certified" as const,
      enabled: true
    }
  ];

  assert.equal(validateSkillSourceRef({ sourceRef: "openai-skills", recommendedSources: allowed }).trusted, true);
  assert.equal(
    validateSkillSourceRef({ sourceRef: "https://evil.example.com/repo", recommendedSources: allowed }).trusted,
    false
  );
});

test("sortSkillsByTrustAndPopularity orders by trust tier first", () => {
  const ordered = sortSkillsByTrustAndPopularity([
    makeSkill("s-standard", { trust_tier: "standard", popularity: { uses: 100, success_rate: 0.9 } }),
    makeSkill("s-certified", { trust_tier: "certified", popularity: { uses: 1, success_rate: 0.5 } }),
    makeSkill("s-popular", { trust_tier: "popular", popularity: { uses: 20, success_rate: 0.8 } })
  ]);
  assert.deepEqual(ordered.map((skill) => skill.id), ["s-certified", "s-popular", "s-standard"]);
});
