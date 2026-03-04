import path from "node:path";
import type { AgentSpec } from "../types/contracts.js";
import { fileExists, listDirs, readText } from "../utils/fs.js";
import { parseYaml } from "../utils/yaml.js";
import { loadPromptSection } from "./prompt-templates.js";

const REQUIRED_SECTIONS = ["persona", "workflow", "style", "capability-policy"] as const;
const GLOBAL_AGENT_FILENAME = "global.md";

type ParsedAgentMarkdown = {
  metadata: Record<string, unknown>;
  sections: Map<string, string>;
};

function resolveAgentsRoot(configRoot: string): string {
  const resolved = path.resolve(configRoot);
  const base = path.basename(resolved);
  if (base === "agents" || base === "agent-designs") {
    return resolved;
  }
  return path.join(resolved, "agents");
}

function normalizeSectionName(name: string): string {
  return name.trim().toLowerCase();
}

function parseFrontmatter(raw: string, sourcePath: string): { metadata: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match || !match[1]) {
    return { metadata: {}, body: raw.trim() };
  }

  return {
    metadata: parseYaml<Record<string, unknown>>(match[1], `${sourcePath}#frontmatter`),
    body: raw.slice(match[0].length).trim()
  };
}

function parseSections(body: string): Map<string, string> {
  const pattern = /^##\s+(.+)$/gm;
  const headers: Array<{ name: string; idx: number; lineLength: number }> = [];
  let match: RegExpExecArray | null = pattern.exec(body);
  while (match) {
    headers.push({
      name: normalizeSectionName(match[1] || ""),
      idx: match.index,
      lineLength: (match[0] || "").length
    });
    match = pattern.exec(body);
  }

  const sections = new Map<string, string>();
  if (headers.length === 0) {
    return sections;
  }

  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    const next = headers[i + 1];
    const start = current.idx + current.lineLength;
    const end = next ? next.idx : body.length;
    const content = body.slice(start, end).trim();
    if (content) {
      sections.set(current.name, content);
    }
  }

  return sections;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim());
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

function parseAgentMarkdown(raw: string, sourcePath: string): ParsedAgentMarkdown {
  const parsed = parseFrontmatter(raw, sourcePath);
  const sections = parseSections(parsed.body);
  return {
    metadata: parsed.metadata,
    sections
  };
}

function sectionOrFallback(parsed: ParsedAgentMarkdown, key: (typeof REQUIRED_SECTIONS)[number], fallback: string): string {
  const section = parsed.sections.get(key);
  return section || fallback;
}

function mergeSection(globalParsed: ParsedAgentMarkdown | null, localParsed: ParsedAgentMarkdown, key: (typeof REQUIRED_SECTIONS)[number], fallback: string): string {
  const globalSection = globalParsed?.sections.get(key)?.trim();
  const localSection = localParsed.sections.get(key)?.trim();
  if (globalSection && localSection) {
    return `${globalSection}\n\n${localSection}`;
  }
  return globalSection || localSection || fallback;
}

async function loadGlobalAgentMarkdown(agentsRoot: string): Promise<ParsedAgentMarkdown | null> {
  const globalPath = path.join(agentsRoot, GLOBAL_AGENT_FILENAME);
  if (!(await fileExists(globalPath))) {
    return null;
  }
  const raw = await readText(globalPath);
  return parseAgentMarkdown(raw, globalPath);
}

export async function loadAgentSpec(id: string, configRoot = path.resolve("user/agents")): Promise<AgentSpec> {
  const agentsRoot = resolveAgentsRoot(configRoot);
  const agentDir = path.join(agentsRoot, id);
  const agentPath = path.join(agentDir, "agent.md");
  if (!(await fileExists(agentPath))) {
    throw new Error(`Agent spec not found: ${agentPath}`);
  }

  const [raw, globalParsed] = await Promise.all([
    readText(agentPath),
    loadGlobalAgentMarkdown(agentsRoot)
  ]);
  const parsed = parseAgentMarkdown(raw, agentPath);

  const persona = mergeSection(globalParsed, parsed, "persona", loadPromptSection("agent-spec/fallback", "persona"));
  const workflow = mergeSection(globalParsed, parsed, "workflow", loadPromptSection("agent-spec/fallback", "workflow"));
  const style = mergeSection(globalParsed, parsed, "style", loadPromptSection("agent-spec/fallback", "style"));
  const capabilityPolicy = mergeSection(
    globalParsed,
    parsed,
    "capability-policy",
    loadPromptSection("agent-spec/fallback", "capability-policy")
  );

  const localAllowlist = toStringArray(parsed.metadata.skill_allowlist).length > 0
    ? toStringArray(parsed.metadata.skill_allowlist)
    : toStringArray(parsed.metadata.skill_whitelist);
  const globalAllowlist = globalParsed
    ? (toStringArray(globalParsed.metadata.skill_allowlist).length > 0
      ? toStringArray(globalParsed.metadata.skill_allowlist)
      : toStringArray(globalParsed.metadata.skill_whitelist))
    : [];

  return {
    id,
    summary: typeof parsed.metadata.summary === "string"
      ? parsed.metadata.summary
      : (typeof globalParsed?.metadata.summary === "string" ? globalParsed.metadata.summary : undefined),
    persona,
    workflow,
    style,
    capabilityPolicy,
    skillWhitelist: mergeUniqueStrings(globalAllowlist, localAllowlist),
    path: agentPath
  };
}

export async function listAgentSpecIds(configRoot = path.resolve("user/agents")): Promise<string[]> {
  const agentsRoot = resolveAgentsRoot(configRoot);
  if (!(await fileExists(agentsRoot))) {
    return [];
  }

  const dirs = await listDirs(agentsRoot);
  const ids: string[] = [];
  for (const dir of dirs) {
    const id = path.basename(dir);
    const agentPath = path.join(dir, "agent.md");
    if (await fileExists(agentPath)) {
      ids.push(id);
    }
  }
  return ids.sort();
}
