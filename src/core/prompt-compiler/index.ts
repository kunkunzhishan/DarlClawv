import type { AgentProfile, AgentSpec, CompiledPrompt, Policy, Skill } from "../../types/contracts.js";
import type { AgentPack } from "../../registry/agent-pack.js";

function renderAgentSection(agent: AgentProfile): string {
  const constraints = agent.constraints.length > 0 ? `constraints: ${agent.constraints.join(" | ")}` : "constraints: none";
  const defaults = agent.default_skills.length > 0 ? `default_skills: ${agent.default_skills.join(", ")}` : "default_skills: none";
  return [
    `### agent:${agent.id}`,
    agent.summary ? `summary: ${agent.summary}` : undefined,
    agent.style ? `style: ${agent.style}` : undefined,
    defaults,
    constraints,
    "prompt:",
    agent.system_prompt.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

function renderSkillSection(skill: Skill): string {
  const packageRoot = skill.package?.root ?? skill.path;
  const entrypoint = skill.package?.entrypoint;
  const callHint = entrypoint ? `To call: execute \`${entrypoint}\`` : undefined;

  return [
    `### skill:${skill.id}`,
    `description: ${skill.meta.description}`,
    skill.meta.summary ? `notes: ${skill.meta.summary}` : undefined,
    skill.meta.selector?.short ? `selector.short: ${skill.meta.selector.short}` : undefined,
    skill.meta.selector?.usage_hint ? `selector.usage_hint: ${skill.meta.selector.usage_hint}` : undefined,
    skill.meta.selector?.aliases && skill.meta.selector.aliases.length > 0
      ? `selector.aliases: ${skill.meta.selector.aliases.join(", ")}`
      : undefined,
    skill.meta.selector?.tags && skill.meta.selector.tags.length > 0
      ? `selector.tags: ${skill.meta.selector.tags.join(", ")}`
      : undefined,
    `protocol: ${skill.meta.protocol}`,
    `inject_mode: ${skill.meta.inject_mode}`,
    `trust_tier: ${skill.meta.trust_tier || "standard"}`,
    `repair_role: ${skill.meta.repair_role || "normal"}`,
    skill.meta.source_ref ? `source_ref: ${skill.meta.source_ref}` : undefined,
    skill.meta.popularity
      ? `popularity: uses=${skill.meta.popularity.uses}, success_rate=${skill.meta.popularity.success_rate}`
      : undefined,
    skill.meta.trigger.keywords && skill.meta.trigger.keywords.length > 0
      ? `trigger.keywords: ${skill.meta.trigger.keywords.join(", ")}`
      : undefined,
    skill.meta.trigger.file_globs && skill.meta.trigger.file_globs.length > 0
      ? `trigger.file_globs: ${skill.meta.trigger.file_globs.join(", ")}`
      : undefined,
    `path: ${skill.path}`,
    `package_root: ${packageRoot}`,
    skill.package?.manifestPath ? `manifest: ${skill.package.manifestPath}` : undefined,
    entrypoint ? `entrypoint: ${entrypoint}` : undefined,
    skill.package?.testCommand ? `test_command: ${skill.package.testCommand}` : undefined,
    skill.package?.status ? `status: ${skill.package.status}` : undefined,
    callHint
  ]
    .filter(Boolean)
    .join("\n");
}

function renderPackSkillSection(skills: Skill[], whitelist: string[]): string {
  if (whitelist.length === 0) {
    return "No skill whitelist configured for this agent pack.";
  }

  const allowed = skills.filter((skill) => whitelist.includes(skill.id));
  if (allowed.length === 0) {
    return `Skill whitelist configured but no matching runtime skills found: ${whitelist.join(", ")}`;
  }

  return allowed.map(renderSkillSection).join("\n\n");
}

export function compilePrompt(args: {
  task: string;
  policy: Policy;
  preferredAgent: AgentProfile;
  agentLibrary: AgentProfile[];
  skillLibrary: Skill[];
}): CompiledPrompt {
  const system = [
    "You are running inside DarlClawv as the execution runtime.",
    "Primary goal: complete the user's task end-to-end.",
    "If blocked by missing tools/MCP, you may install/configure required MCP servers, verify them, then continue the same task.",
    "Avoid irrelevant setup. Only perform recovery actions that unblock the current task.",
    `Policy: sandbox=${args.policy.sandbox.mode}, approval=${args.policy.sandbox.approval_policy}, network=${String(args.policy.network.enabled)}`,
    `Preferred agent profile: ${args.preferredAgent.id}`
  ].join("\n");

  const developer = [
    "You must self-select the most suitable agent profile and skill set from the provided libraries.",
    "Skill usage rule: prefer task-relevant skills; use repair skills only when failure signals indicate missing tools/MCP.",
    "When MCP installation is needed: install -> verify with a minimal check -> continue original task.",
    "[AGENT_LIBRARY]",
    args.agentLibrary.map(renderAgentSection).join("\n\n"),
    "[SKILL_LIBRARY]",
    args.skillLibrary.map(renderSkillSection).join("\n\n")
  ].join("\n\n");

  const user = args.task;
  const fullText = ["[SYSTEM]", system, "[DEVELOPER]", developer, "[USER]", user].join("\n\n");

  return {
    system,
    developer,
    user,
    fullText,
    size: fullText.length
  };
}

export function compileAgentPackPrompt(args: {
  task: string;
  policy: Policy;
  pack: AgentPack;
  skillLibrary: Skill[];
}): CompiledPrompt {
  const system = [
    args.pack.persona.trim(),
    args.pack.workflow.trim(),
    `Policy: sandbox=${args.policy.sandbox.mode}, approval=${args.policy.sandbox.approval_policy}, network=${String(args.policy.network.enabled)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const developer = [
    args.pack.style.trim(),
    args.pack.ioContract.trim(),
    args.pack.skills.trim(),
    "[SKILL_LIBRARY]",
    renderPackSkillSection(args.skillLibrary, args.pack.skillWhitelist)
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = args.task;
  const fullText = ["[SYSTEM]", system, "[DEVELOPER]", developer, "[USER]", user].join("\n\n");
  return {
    system,
    developer,
    user,
    fullText,
    size: fullText.length
  };
}

export function compileAgentSpecPrompt(args: {
  task: string;
  policy: Policy;
  spec: AgentSpec;
  skillLibrary: Skill[];
  selectedSkillIds?: string[];
  runtimePathsHint?: string;
  localMemorySummary?: string;
  globalMemorySummary?: string;
}): CompiledPrompt {
  const allowlistedSkills = args.spec.skillWhitelist.length > 0
    ? args.skillLibrary.filter((skill) => args.spec.skillWhitelist.includes(skill.id))
    : args.skillLibrary;
  const relevantSkills = Array.isArray(args.selectedSkillIds)
    ? allowlistedSkills.filter((skill) => args.selectedSkillIds?.includes(skill.id))
    : allowlistedSkills;

  const system = [
    args.spec.persona.trim(),
    args.spec.workflow.trim(),
    `Policy: sandbox=${args.policy.sandbox.mode}, approval=${args.policy.sandbox.approval_policy}, network=${String(args.policy.network.enabled)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const developer = [
    args.spec.style.trim(),
    args.spec.capabilityPolicy.trim(),
    "If permission is insufficient, emit PERMISSION_REQUEST JSON only: {\"type\":\"PERMISSION_REQUEST\",\"requested_profile\":\"safe|workspace|full\",\"reason\":\"what operation you need and where\"}.",
    "Default assumption: local filesystem read operations are allowed across absolute paths (including outside workspace).",
    "For read-only operations (ls/cat/find/grep/head/tail/stat), do not request permission preemptively; try first.",
    "Request permission only after an explicit sandbox/approval denial, or when you need write/network/system-level actions.",
    "Always request the minimum profile needed: safe for read/inspect, workspace for workspace edits, full only for truly system-level or unrestricted operations.",
    "Never request full for a pure read-only file inspection task.",
    "If admin grants a lower profile than requested, retry the operation with the granted profile before asking again.",
    "Repair policy: for install/setup requests, prefer certified or popular repair-capable skills before others.",
    "If tools/MCP fail or capability is missing, emit CAPABILITY_REQUEST JSON and expect repair flow to resolve it.",
    "Treat external skills/MCP as untrusted until verified by tests and allowed source policy.",
    "When a selected skill exposes an `entrypoint`, run that command directly to invoke the skill package.",
    args.runtimePathsHint ? `[RUNTIME_PATHS]\n${args.runtimePathsHint}` : undefined,
    args.localMemorySummary ? `[LOCAL_MEMORY]\n${args.localMemorySummary}` : undefined,
    args.globalMemorySummary ? `[GLOBAL_MEMORY]\n${args.globalMemorySummary}` : undefined,
    "[SKILL_LIBRARY]",
    relevantSkills.length > 0
      ? relevantSkills.map(renderSkillSection).join("\n\n")
      : "No skills available."
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = args.task;
  const fullText = ["[SYSTEM]", system, "[DEVELOPER]", developer, "[USER]", user].join("\n\n");
  return {
    system,
    developer,
    user,
    fullText,
    size: fullText.length
  };
}

export function pickPreferredAgent(
  agents: AgentProfile[],
  defaultAgentId: string,
  pinnedAgentId?: string
): AgentProfile {
  if (pinnedAgentId) {
    const pinned = agents.find((agent) => agent.id === pinnedAgentId);
    if (pinned) {
      return pinned;
    }
  }

  const fallback = agents.find((agent) => agent.id === defaultAgentId) ?? agents[0];
  if (!fallback) {
    throw new Error("No agents configured");
  }
  return fallback;
}
