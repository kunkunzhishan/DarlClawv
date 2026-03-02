import test from "node:test";
import assert from "node:assert/strict";
import { fallbackSelectSkills, selectSkillsForTask } from "../src/core/skill-selector/index.js";
import type { AgentSpec, Skill } from "../src/types/contracts.js";

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

const spec: AgentSpec = {
  id: "default",
  summary: "test",
  persona: "persona",
  workflow: "workflow",
  style: "style",
  capabilityPolicy: "dynamic-skill-selection",
  skillWhitelist: [],
  path: "/tmp/agent.md"
};

test("selectSkillsForTask parses llm skill selection output", async () => {
  const skills = [makeSkill("repo-basics"), makeSkill("mcp-recovery")];
  const fakeClient = {
    startThread: () => ({ id: "selector-thread" }),
    runThread: async () => ({
      outputText: JSON.stringify({
        selected_skill_ids: ["repo-basics"],
        reason: "coding task"
      }),
      threadId: "selector-thread"
    })
  };

  const selected = await selectSkillsForTask({
    task: "修一个仓库里的 bug",
    spec,
    skillLibrary: skills,
    sdkClient: fakeClient as any
  });

  assert.equal(selected.mode, "llm");
  assert.deepEqual(selected.selectedSkillIds, ["repo-basics"]);
});

test("fallbackSelectSkills ranks by selector aliases and keywords", () => {
  const skills = [
    makeSkill("repo-basics", {
      trigger: { keywords: ["bug"] },
      selector: { aliases: ["修复"], tags: ["coding"] }
    }),
    makeSkill("mcp-recovery", {
      trigger: { keywords: ["mcp"] },
      selector: { aliases: ["工具恢复"], tags: ["integration"] }
    })
  ];

  const selected = fallbackSelectSkills({
    task: "这个任务需要修复一个 bug",
    skillLibrary: skills
  });

  assert.equal(selected.mode, "fallback");
  assert.equal(selected.selectedSkillIds[0], "repo-basics");
});

test("fallbackSelectSkills prefers repair skill for install intent", () => {
  const skills = [
    makeSkill("repo-basics", {
      trust_tier: "popular",
      repair_role: "normal"
    }),
    makeSkill("mcp-recovery", {
      trust_tier: "certified",
      repair_role: "repair"
    })
  ];

  const selected = fallbackSelectSkills({
    task: "请安装并配置缺失工具",
    skillLibrary: skills,
    installIntent: true
  });

  assert.equal(selected.selectedSkillIds[0], "mcp-recovery");
});
