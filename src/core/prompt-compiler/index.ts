import type { AgentSpec, CompiledPrompt, Policy, Skill } from "../../types/contracts.js";
import { renderPromptSection, renderPromptTemplate } from "../../registry/prompt-templates.js";

function filterPromptSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => !skill.meta.channel);
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
  const promptSkills = filterPromptSkills(allowlistedSkills);
  const relevantSkills = Array.isArray(args.selectedSkillIds)
    ? promptSkills.filter((skill) => args.selectedSkillIds?.includes(skill.id))
    : promptSkills;

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

export function compileWorkerPrompt(args: {
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
  const promptSkills = filterPromptSkills(allowlistedSkills);
  const relevantSkills = Array.isArray(args.selectedSkillIds)
    ? promptSkills.filter((skill) => args.selectedSkillIds?.includes(skill.id))
    : promptSkills;

  const system = renderPromptTemplate("prompt-compiler/compile-worker-system", {
    sandbox_mode: args.policy.sandbox.mode,
    approval_policy: args.policy.sandbox.approval_policy,
    network_enabled: String(args.policy.network.enabled)
  });

  const developer = renderPromptTemplate("prompt-compiler/compile-worker-developer", {
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
