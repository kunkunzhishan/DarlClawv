import type { AgentProfile, AgentSpec, CompiledPrompt, Policy, Skill } from "../../types/contracts.js";
import type { AgentPack } from "../../registry/agent-pack.js";
import { renderPromptSection, renderPromptTemplate } from "../../registry/prompt-templates.js";

function renderAgentSection(agent: AgentProfile): string {
  const defaults = agent.default_skills.length > 0 ? agent.default_skills.join(", ") : "none";
  const constraints = agent.constraints.length > 0 ? agent.constraints.join(" | ") : "none";
  return renderPromptTemplate("prompt-compiler/agent-section", {
    id: agent.id,
    summary_line: agent.summary ? `summary: ${agent.summary}` : "",
    style_line: agent.style ? `style: ${agent.style}` : "",
    default_skills: defaults,
    constraints,
    system_prompt: agent.system_prompt.trim()
  });
}

function renderSkillSection(skill: Skill): string {
  const packageRoot = skill.package?.root ?? skill.path;
  const entrypoint = skill.package?.entrypoint;

  return renderPromptTemplate("prompt-compiler/skill-section", {
    id: skill.id,
    description: skill.meta.description,
    notes_line: skill.meta.summary ? `notes: ${skill.meta.summary}` : "",
    selector_short_line: skill.meta.selector?.short ? `selector.short: ${skill.meta.selector.short}` : "",
    selector_usage_hint_line: skill.meta.selector?.usage_hint
      ? `selector.usage_hint: ${skill.meta.selector.usage_hint}`
      : "",
    selector_aliases_line: skill.meta.selector?.aliases && skill.meta.selector.aliases.length > 0
      ? `selector.aliases: ${skill.meta.selector.aliases.join(", ")}`
      : "",
    selector_tags_line: skill.meta.selector?.tags && skill.meta.selector.tags.length > 0
      ? `selector.tags: ${skill.meta.selector.tags.join(", ")}`
      : "",
    protocol: skill.meta.protocol,
    inject_mode: skill.meta.inject_mode,
    trust_tier: skill.meta.trust_tier || "standard",
    repair_role: skill.meta.repair_role || "normal",
    source_ref_line: skill.meta.source_ref ? `source_ref: ${skill.meta.source_ref}` : "",
    popularity_line: skill.meta.popularity
      ? `popularity: uses=${skill.meta.popularity.uses}, success_rate=${skill.meta.popularity.success_rate}`
      : "",
    trigger_keywords_line: skill.meta.trigger.keywords && skill.meta.trigger.keywords.length > 0
      ? `trigger.keywords: ${skill.meta.trigger.keywords.join(", ")}`
      : "",
    trigger_file_globs_line: skill.meta.trigger.file_globs && skill.meta.trigger.file_globs.length > 0
      ? `trigger.file_globs: ${skill.meta.trigger.file_globs.join(", ")}`
      : "",
    path: skill.path,
    package_root: packageRoot,
    manifest_line: skill.package?.manifestPath ? `manifest: ${skill.package.manifestPath}` : "",
    entrypoint_line: entrypoint ? `entrypoint: ${entrypoint}` : "",
    test_command_line: skill.package?.testCommand ? `test_command: ${skill.package.testCommand}` : "",
    status_line: skill.package?.status ? `status: ${skill.package.status}` : "",
    call_hint_line: entrypoint ? `To call: execute \`${entrypoint}\`` : ""
  });
}

function renderPackSkillSection(skills: Skill[], whitelist: string[]): string {
  if (whitelist.length === 0) {
    return renderPromptSection("prompt-compiler/messages", "pack-skill-whitelist-none", {});
  }

  const allowed = skills.filter((skill) => whitelist.includes(skill.id));
  if (allowed.length === 0) {
    return renderPromptSection("prompt-compiler/messages", "pack-skill-whitelist-missing", {
      whitelist: whitelist.join(", ")
    });
  }

  return allowed.map(renderSkillSection).join("\n\n");
}

function renderCommonChatPrompt(system: string, developer: string, user: string): CompiledPrompt {
  const fullText = renderPromptTemplate("common/chat-wrapper", {
    system,
    developer,
    user
  });
  return {
    system,
    developer,
    user,
    fullText,
    size: fullText.length
  };
}

function renderOptionalSection(sectionName: string, content?: string): string {
  if (!content) {
    return "";
  }
  return renderPromptSection("prompt-compiler/sections", sectionName, { content });
}

export function compilePrompt(args: {
  task: string;
  policy: Policy;
  preferredAgent: AgentProfile;
  agentLibrary: AgentProfile[];
  skillLibrary: Skill[];
}): CompiledPrompt {
  const system = renderPromptTemplate("prompt-compiler/compile-runtime-system", {
    sandbox_mode: args.policy.sandbox.mode,
    approval_policy: args.policy.sandbox.approval_policy,
    network_enabled: String(args.policy.network.enabled),
    preferred_agent_id: args.preferredAgent.id
  });
  const developer = renderPromptTemplate("prompt-compiler/compile-runtime-developer", {
    agent_library: args.agentLibrary.map(renderAgentSection).join("\n\n"),
    skill_library: args.skillLibrary.map(renderSkillSection).join("\n\n")
  });
  return renderCommonChatPrompt(system, developer, args.task);
}

export function compileAgentPackPrompt(args: {
  task: string;
  policy: Policy;
  pack: AgentPack;
  skillLibrary: Skill[];
}): CompiledPrompt {
  const system = renderPromptTemplate("prompt-compiler/compile-agent-system", {
    persona: args.pack.persona.trim(),
    workflow: args.pack.workflow.trim(),
    sandbox_mode: args.policy.sandbox.mode,
    approval_policy: args.policy.sandbox.approval_policy,
    network_enabled: String(args.policy.network.enabled)
  });

  const developer = renderPromptTemplate("prompt-compiler/compile-agent-pack-developer", {
    style: args.pack.style.trim(),
    io_contract: args.pack.ioContract.trim(),
    skills_policy: args.pack.skills.trim(),
    skill_library: renderPackSkillSection(args.skillLibrary, args.pack.skillWhitelist)
  });

  return renderCommonChatPrompt(system, developer, args.task);
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

  const system = renderPromptTemplate("prompt-compiler/compile-agent-system", {
    persona: args.spec.persona.trim(),
    workflow: args.spec.workflow.trim(),
    sandbox_mode: args.policy.sandbox.mode,
    approval_policy: args.policy.sandbox.approval_policy,
    network_enabled: String(args.policy.network.enabled)
  });

  const developer = renderPromptTemplate("prompt-compiler/compile-agent-spec-developer", {
    style: args.spec.style.trim(),
    capability_policy: args.spec.capabilityPolicy.trim(),
    runtime_paths_section: renderOptionalSection("runtime-paths", args.runtimePathsHint),
    local_memory_section: renderOptionalSection("local-memory", args.localMemorySummary),
    global_memory_section: renderOptionalSection("global-memory", args.globalMemorySummary),
    skill_library: relevantSkills.length > 0
      ? relevantSkills.map(renderSkillSection).join("\n\n")
      : renderPromptSection("prompt-compiler/messages", "no-skills-available", {})
  });

  return renderCommonChatPrompt(system, developer, args.task);
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
