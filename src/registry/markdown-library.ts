import path from "node:path";
import type { AgentProfile, Skill, SkillMeta } from "../types/contracts.js";
import { fileExists, readText } from "../utils/fs.js";
import { parseYaml } from "../utils/yaml.js";

type Section = {
  title: string;
  metadata: Record<string, unknown>;
  body: string;
};

function parseSections(markdown: string): Section[] {
  const pattern = /^##\s+(.+)$/gm;
  const headers: Array<{ title: string; index: number }> = [];
  let match: RegExpExecArray | null = pattern.exec(markdown);
  while (match) {
    headers.push({ title: match[1]?.trim() ?? "", index: match.index });
    match = pattern.exec(markdown);
  }

  const sections: Section[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    const next = headers[i + 1];
    const start = current.index + (current.title.length + 4);
    const end = next ? next.index : markdown.length;
    const raw = markdown.slice(start, end).trim();

    let metadata: Record<string, unknown> = {};
    let body = raw;
    const yamlFence = raw.match(/^```yaml\n([\s\S]*?)\n```\n?/);
    if (yamlFence && yamlFence[1]) {
      metadata = parseYaml<Record<string, unknown>>(yamlFence[1], `section:${current.title}`);
      body = raw.slice(yamlFence[0].length).trim();
    }

    sections.push({
      title: current.title,
      metadata,
      body
    });
  }

  return sections;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function mergeUniqueStrings(...groups: string[][]): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      const value = item.trim();
      if (value) {
        merged.add(value);
      }
    }
  }
  return [...merged];
}

export async function loadAgentMarkdownLibrary(configRoot = path.resolve("src/config")): Promise<Map<string, AgentProfile>> {
  const filePath = path.join(configRoot, "agents.md");
  if (!(await fileExists(filePath))) {
    return new Map();
  }

  const raw = await readText(filePath);
  const sections = parseSections(raw);
  const out = new Map<string, AgentProfile>();

  for (const section of sections) {
    const id = (typeof section.metadata.id === "string" ? section.metadata.id : section.title).trim();
    const systemPromptFromMeta =
      typeof section.metadata.system_prompt === "string" ? section.metadata.system_prompt : undefined;
    const system_prompt = section.body || systemPromptFromMeta || "";
    if (!id || !system_prompt) {
      continue;
    }

    const agent: AgentProfile = {
      id,
      system_prompt,
      style: typeof section.metadata.style === "string" ? section.metadata.style : undefined,
      default_skills: toStringArray(section.metadata.default_skills),
      constraints: toStringArray(section.metadata.constraints),
      summary: typeof section.metadata.summary === "string" ? section.metadata.summary : undefined,
      keywords: toStringArray(section.metadata.keywords)
    };

    out.set(id, agent);
  }

  return out;
}

export async function loadSkillMarkdownLibrary(configRoot = path.resolve("src/config")): Promise<Map<string, Skill>> {
  const resolvedConfigRoot = path.resolve(configRoot);
  const defaultConfigRoot = path.resolve("src/config");
  const defaultPath = path.resolve("user", "skills.md");
  const fallbackPath = path.join(configRoot, "skills.md");
  const filePath = (resolvedConfigRoot === defaultConfigRoot && (await fileExists(defaultPath)))
    ? defaultPath
    : fallbackPath;
  if (!(await fileExists(filePath))) {
    return new Map();
  }

  const raw = await readText(filePath);
  const sections = parseSections(raw);
  const out = new Map<string, Skill>();

  for (const section of sections) {
    const id = (typeof section.metadata.id === "string" ? section.metadata.id : section.title).trim();
    if (!id || !section.body) {
      continue;
    }

    const triggerMeta = toRecord(section.metadata.trigger);
    const selectorMeta = toRecord(section.metadata.selector);
    const selectorAliases = mergeUniqueStrings(
      toStringArray(selectorMeta.aliases),
      toStringArray(section.metadata.aliases)
    );
    const selectorTags = mergeUniqueStrings(toStringArray(selectorMeta.tags), toStringArray(section.metadata.tags));
    const selectorShort = toString(selectorMeta.short) ?? toString(section.metadata.short);
    const selectorUsageHint = toString(selectorMeta.usage_hint) ?? toString(section.metadata.usage_hint);
    const limitsMeta = toRecord(section.metadata.limits);

    const description =
      (typeof section.metadata.description === "string" && section.metadata.description.trim()) ||
      (typeof section.metadata.summary === "string" && section.metadata.summary.trim()) ||
      "Skill loaded from markdown library section.";

    const meta: SkillMeta = {
      name: id,
      description,
      protocol: "codex-skill-v1",
      trigger: {
        keywords: toStringArray(triggerMeta.keywords),
        file_globs: toStringArray(triggerMeta.file_globs)
      },
      selector:
        selectorShort || selectorUsageHint || selectorAliases.length > 0 || selectorTags.length > 0
          ? {
              short: selectorShort,
              usage_hint: selectorUsageHint,
              aliases: selectorAliases,
              tags: selectorTags
            }
          : undefined,
      inject_mode: section.metadata.inject_mode === "append" ? "append" : "prepend",
      limits: typeof limitsMeta.max_tokens === "number"
        ? { max_tokens: limitsMeta.max_tokens as number }
        : undefined,
      summary: typeof section.metadata.summary === "string" ? section.metadata.summary : undefined,
      trust_tier:
        section.metadata.trust_tier === "certified" ||
        section.metadata.trust_tier === "popular" ||
        section.metadata.trust_tier === "standard" ||
        section.metadata.trust_tier === "untrusted"
          ? section.metadata.trust_tier
          : undefined,
      source_ref: typeof section.metadata.source_ref === "string" ? section.metadata.source_ref : undefined,
      popularity: typeof section.metadata.popularity === "object" && section.metadata.popularity !== null
        ? {
            uses:
              typeof (section.metadata.popularity as Record<string, unknown>).uses === "number"
                ? Math.max(0, Math.trunc((section.metadata.popularity as Record<string, unknown>).uses as number))
                : 0,
            success_rate:
              typeof (section.metadata.popularity as Record<string, unknown>).success_rate === "number"
                ? Math.max(0, Math.min(1, (section.metadata.popularity as Record<string, unknown>).success_rate as number))
                : 0
          }
        : undefined,
      repair_role:
        section.metadata.repair_role === "repair" || section.metadata.repair_role === "normal"
          ? section.metadata.repair_role
          : undefined
    };

    const skill: Skill = {
      id,
      meta,
      body: section.body,
      path: filePath
    };

    out.set(id, skill);
  }

  return out;
}
