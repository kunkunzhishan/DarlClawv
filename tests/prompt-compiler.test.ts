import test from "node:test";
import assert from "node:assert/strict";
import { compileAgentPackPrompt, compileAgentSpecPrompt, compilePrompt, pickPreferredAgent } from "../src/core/prompt-compiler/index.js";
import type { AgentPack } from "../src/registry/agent-pack.js";
import type { AgentProfile, AgentSpec, Policy, Skill } from "../src/types/contracts.js";

test("compilePrompt produces three-layer structure with libraries", () => {
  const agent: AgentProfile = {
    id: "default",
    system_prompt: "sys",
    default_skills: ["repo-basics"],
    constraints: ["c1"],
    summary: "default summary"
  };
  const policy: Policy = {
    id: "p1",
    sandbox: { mode: "workspace-write", approval_policy: "on-request" },
    network: { enabled: true }
  };
  const skill: Skill = {
    id: "repo-basics",
    path: "/tmp/repo-basics",
    body: "skill body",
    meta: {
      name: "repo-basics",
      description: "Inspect repo and make minimal edits.",
      protocol: "codex-skill-v1",
      trigger: { keywords: ["repo"] },
      inject_mode: "prepend"
    }
  };

  const prompt = compilePrompt({
    task: "hello",
    policy,
    preferredAgent: agent,
    agentLibrary: [agent],
    skillLibrary: [skill]
  });

  assert.match(prompt.fullText, /\[SYSTEM\]/);
  assert.match(prompt.fullText, /\[DEVELOPER\]/);
  assert.match(prompt.fullText, /\[USER\]/);
  assert.match(prompt.fullText, /AGENT_LIBRARY/);
  assert.match(prompt.fullText, /SKILL_LIBRARY/);
  assert.equal(prompt.user, "hello");
  assert.doesNotMatch(prompt.fullText, /skill body/);
});

test("pickPreferredAgent honors pinned id and fallback", () => {
  const agents: AgentProfile[] = [
    {
      id: "default",
      system_prompt: "default",
      default_skills: [],
      constraints: []
    },
    {
      id: "frontend",
      system_prompt: "frontend",
      default_skills: [],
      constraints: []
    }
  ];

  const pinned = pickPreferredAgent(agents, "default", "frontend");
  assert.equal(pinned.id, "frontend");

  const fallback = pickPreferredAgent(agents, "default", "missing");
  assert.equal(fallback.id, "default");
});

test("compileAgentPackPrompt injects pack sections and whitelisted skills", () => {
  const policy: Policy = {
    id: "p1",
    sandbox: { mode: "workspace-write", approval_policy: "on-request" },
    network: { enabled: true }
  };

  const skill: Skill = {
    id: "repo-basics",
    path: "/tmp/repo-basics",
    body: "skill body",
    meta: {
      name: "repo-basics",
      description: "Inspect repo and make minimal edits.",
      protocol: "codex-skill-v1",
      trigger: { keywords: ["repo"] },
      inject_mode: "prepend"
    }
  };

  const pack: AgentPack = {
    id: "main-worker",
    persona: "persona",
    workflow: "workflow",
    style: "style",
    ioContract: "io",
    skills: "skills rules",
    skillWhitelist: ["repo-basics"],
    path: "/tmp/main-worker"
  };

  const prompt = compileAgentPackPrompt({
    task: "hello",
    policy,
    pack,
    skillLibrary: [skill]
  });

  assert.match(prompt.fullText, /persona/);
  assert.match(prompt.fullText, /workflow/);
  assert.match(prompt.fullText, /skills rules/);
  assert.match(prompt.fullText, /skill:repo-basics/);
  assert.doesNotMatch(prompt.fullText, /skill body/);
});

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
