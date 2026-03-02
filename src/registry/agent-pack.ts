import path from "node:path";
import { fileExists, listDirs, readText } from "../utils/fs.js";
import { parseYaml } from "../utils/yaml.js";

export type AgentPack = {
  id: string;
  persona: string;
  workflow: string;
  style: string;
  ioContract: string;
  skills: string;
  skillWhitelist: string[];
  path: string;
};

function parseFrontmatter(content: string, source: string): { metadata: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match || !match[1]) {
    return { metadata: {}, body: content.trim() };
  }

  return {
    metadata: parseYaml<Record<string, unknown>>(match[1], `${source}#frontmatter`),
    body: content.slice(match[0].length).trim()
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim());
}

async function readRequiredMarkdown(dir: string, name: string): Promise<{ metadata: Record<string, unknown>; body: string }> {
  const filePath = path.join(dir, name);
  if (!(await fileExists(filePath))) {
    throw new Error(`Agent pack contract violation in ${dir}: missing required file ${name}`);
  }

  const raw = await readText(filePath);
  const parsed = parseFrontmatter(raw, filePath);
  if (!parsed.body) {
    throw new Error(`Agent pack contract violation in ${filePath}: body is required`);
  }
  return parsed;
}

export async function loadAgentPack(id: string, configRoot = path.resolve("config")): Promise<AgentPack> {
  const packDir = path.join(configRoot, "agent-packs", id);
  if (!(await fileExists(packDir))) {
    throw new Error(`Agent pack not found: ${id}`);
  }

  const [persona, workflow, style, ioContract, skills] = await Promise.all([
    readRequiredMarkdown(packDir, "persona.md"),
    readRequiredMarkdown(packDir, "workflow.md"),
    readRequiredMarkdown(packDir, "style.md"),
    readRequiredMarkdown(packDir, "io-contract.md"),
    readRequiredMarkdown(packDir, "skills.md")
  ]);

  const whitelist = toStringArray(skills.metadata.whitelist);

  return {
    id,
    persona: persona.body,
    workflow: workflow.body,
    style: style.body,
    ioContract: ioContract.body,
    skills: skills.body,
    skillWhitelist: whitelist,
    path: packDir
  };
}

export async function loadAgentPacks(configRoot = path.resolve("config")): Promise<Map<string, AgentPack>> {
  const packsRoot = path.join(configRoot, "agent-packs");
  if (!(await fileExists(packsRoot))) {
    return new Map();
  }

  const dirs = await listDirs(packsRoot);
  const entries = await Promise.all(
    dirs.map(async (dir) => {
      const id = path.basename(dir);
      return [id, await loadAgentPack(id, configRoot)] as const;
    })
  );

  return new Map(entries);
}
