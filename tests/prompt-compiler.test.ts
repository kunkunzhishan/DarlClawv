import test from "node:test";
import assert from "node:assert/strict";
import { compileAgentSpecPrompt } from "../src/core/prompt-compiler/index.js";
import type { AgentSpec, Policy, Skill } from "../src/types/contracts.js";

test("compileAgentSpecPrompt injects memory summaries and skill metadata", () => {
  const policy: Policy = {
    id: "p1",
    sandbox: { mode: "workspace-write", approval_policy: "on-request" },
    network: { enabled: true }
  };

  const skill: Skill = {
    id: "repo-basics",
    path: "/tmp/repo-basics/SKILL.md",
    body: "skill body",
    meta: {
      name: "repo-basics",
      description: "Inspect repo and make minimal edits.",
      protocol: "codex-skill-v1",
      trigger: { keywords: ["repo"] },
      inject_mode: "prepend"
    }
  };

  const spec: AgentSpec = {
    id: "default",
    summary: "summary",
    persona: "persona",
    workflow: "workflow",
    style: "style",
    capabilityPolicy: "capability-policy",
    skillWhitelist: ["repo-basics"],
    path: "/tmp/agent.md"
  };

  const prompt = compileAgentSpecPrompt({
    task: "hello",
    policy,
    spec,
    skillLibrary: [skill],
    localMemorySummary: "local-memory",
    globalMemorySummary: "global-memory"
  });

  assert.match(prompt.fullText, /local-memory/);
  assert.match(prompt.fullText, /global-memory/);
  assert.match(prompt.fullText, /path: \/tmp\/repo-basics\/SKILL.md/);
  assert.doesNotMatch(prompt.fullText, /skill body/);
});

test("compileAgentSpecPrompt can inject only selected skills", () => {
  const policy: Policy = {
    id: "p1",
    sandbox: { mode: "workspace-write", approval_policy: "on-request" },
    network: { enabled: true }
  };

  const skills: Skill[] = [
    {
      id: "repo-basics",
      path: "/tmp/repo-basics/SKILL.md",
      body: "skill body",
      meta: {
        name: "repo-basics",
        description: "Inspect repo and make minimal edits.",
        protocol: "codex-skill-v1",
        trigger: { keywords: ["repo"] },
        inject_mode: "prepend"
      }
    },
    {
      id: "mcp-recovery",
      path: "/tmp/mcp-recovery/SKILL.md",
      body: "skill body",
      meta: {
        name: "mcp-recovery",
        description: "Recover MCP tools.",
        protocol: "codex-skill-v1",
        trigger: { keywords: ["mcp"] },
        inject_mode: "append"
      },
      package: {
        root: "/tmp/mcp-recovery",
        entrypoint: "python3 /tmp/mcp-recovery/scripts/run.py",
        status: "active"
      }
    }
  ];

  const spec: AgentSpec = {
    id: "default",
    summary: "summary",
    persona: "persona",
    workflow: "workflow",
    style: "style",
    capabilityPolicy: "capability-policy",
    skillWhitelist: [],
    path: "/tmp/agent.md"
  };

  const prompt = compileAgentSpecPrompt({
    task: "hello",
    policy,
    spec,
    skillLibrary: skills,
    selectedSkillIds: ["mcp-recovery"]
  });

  assert.match(prompt.fullText, /skill:mcp-recovery/);
  assert.match(prompt.fullText, /entrypoint: python3 \/tmp\/mcp-recovery\/scripts\/run.py/);
  assert.match(prompt.fullText, /To call: execute/);
  assert.doesNotMatch(prompt.fullText, /skill:repo-basics/);
});
