import path from "node:path";
import { fileExists, readText, writeText, ensureDir, listDirs } from "../../utils/fs.js";
import type { RuntimeLibraryPaths, Skill } from "../../types/contracts.js";
import { parseYaml } from "../../utils/yaml.js";

export type RuntimeCapabilityIndex = {
  updatedAt: string;
  capabilities: Array<{
    id: string;
    path: string;
    kind: "script" | "skill" | "mcp" | "hybrid";
    status: "draft" | "tested" | "active";
    lastUsedAt: string;
  }>;
};

export type RuntimeCapabilityRecord = RuntimeCapabilityIndex["capabilities"][number];

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultRuntimeLibraryPaths(root = path.resolve(".mydarl-runtime/staging")): RuntimeLibraryPaths {
  return {
    root,
    scriptsDir: path.join(root, "scripts"),
    skillsDir: path.join(root, "skills"),
    mcpDir: path.join(root, "mcp"),
    testsDir: path.join(root, "tests"),
    logsDir: path.join(root, "logs"),
    indexPath: path.join(root, "index.json")
  };
}

export async function ensureRuntimeLibrary(root?: string): Promise<RuntimeLibraryPaths> {
  const paths = defaultRuntimeLibraryPaths(root);
  await Promise.all([
    ensureDir(paths.root),
    ensureDir(paths.scriptsDir),
    ensureDir(paths.skillsDir),
    ensureDir(paths.mcpDir),
    ensureDir(paths.testsDir),
    ensureDir(paths.logsDir)
  ]);

  if (!(await fileExists(paths.indexPath))) {
    const initial: RuntimeCapabilityIndex = { updatedAt: nowIso(), capabilities: [] };
    await writeText(paths.indexPath, JSON.stringify(initial, null, 2));
  }

  return paths;
}

export async function readRuntimeCapabilityIndex(paths: RuntimeLibraryPaths): Promise<RuntimeCapabilityIndex> {
  if (!(await fileExists(paths.indexPath))) {
    return { updatedAt: nowIso(), capabilities: [] };
  }

  try {
    return JSON.parse(await readText(paths.indexPath)) as RuntimeCapabilityIndex;
  } catch {
    return { updatedAt: nowIso(), capabilities: [] };
  }
}

export async function writeRuntimeCapabilityIndex(paths: RuntimeLibraryPaths, index: RuntimeCapabilityIndex): Promise<void> {
  await writeText(paths.indexPath, JSON.stringify(index, null, 2));
}

export async function findRuntimeCapability(
  paths: RuntimeLibraryPaths,
  capabilityId: string
): Promise<RuntimeCapabilityRecord | null> {
  const index = await readRuntimeCapabilityIndex(paths);
  return index.capabilities.find((item) => item.id === capabilityId) ?? null;
}

export async function upsertRuntimeCapability(
  paths: RuntimeLibraryPaths,
  capability: RuntimeCapabilityRecord
): Promise<RuntimeCapabilityRecord> {
  const index = await readRuntimeCapabilityIndex(paths);
  const nextItems = index.capabilities.filter((item) => item.id !== capability.id);
  nextItems.push(capability);
  const next: RuntimeCapabilityIndex = {
    updatedAt: nowIso(),
    capabilities: nextItems.sort((a, b) => a.id.localeCompare(b.id))
  };
  await writeRuntimeCapabilityIndex(paths, next);
  return capability;
}

export async function listRuntimeSkillDirs(paths: RuntimeLibraryPaths): Promise<string[]> {
  if (!(await fileExists(paths.skillsDir))) {
    return [];
  }
  return await listDirs(paths.skillsDir);
}

function parseFrontmatter(filePath: string, content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match || !match[1]) {
    throw new Error(`Runtime skill contract violation in ${filePath}: SKILL.md requires YAML frontmatter`);
  }

  const frontmatter = parseYaml<Record<string, unknown>>(match[1], `${filePath}#frontmatter`);
  const body = content.slice(match[0].length).trim();
  return { frontmatter, body };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePackageManifest(raw: unknown): { entrypoint?: string; testCommand?: string } {
  const manifest = toRecord(raw);
  const commands = toRecord(manifest.commands);
  return {
    entrypoint: toString(manifest.entrypoint) ?? toString(commands.run),
    testCommand: toString(manifest.test) ?? toString(commands.test)
  };
}

export async function loadRuntimeSkills(paths: RuntimeLibraryPaths): Promise<Skill[]> {
  const dirs = await listRuntimeSkillDirs(paths);
  const items: Skill[] = [];

  for (const dir of dirs) {
    const skillPath = path.join(dir, "SKILL.md");
    if (!(await fileExists(skillPath))) {
      continue;
    }

    try {
      const raw = await readText(skillPath);
      const parsed = parseFrontmatter(skillPath, raw);
      const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : path.basename(dir);
      const description = typeof parsed.frontmatter.description === "string"
        ? parsed.frontmatter.description
        : "Runtime capability skill";
      const metadata = (parsed.frontmatter.metadata as Record<string, unknown> | undefined) ?? {};
      const trigger = (metadata.trigger as Record<string, unknown> | undefined) ?? {};
      const selector = toRecord(metadata.selector);
      const selectorAliases = toStringArray(selector.aliases);
      const selectorTags = toStringArray(selector.tags);
      const manifestPath = path.join(dir, "manifest.yaml");
      const manifest = await fileExists(manifestPath)
        ? parsePackageManifest(parseYaml(await readText(manifestPath), manifestPath))
        : {};

      items.push({
        id: name,
        meta: {
          name,
          description,
          protocol: "codex-skill-v1",
          trigger: {
            keywords: toStringArray(trigger.keywords),
            file_globs: toStringArray(trigger.file_globs)
          },
          selector:
            typeof selector.short === "string" ||
            typeof selector.usage_hint === "string" ||
            selectorAliases.length > 0 ||
            selectorTags.length > 0
              ? {
                  short: typeof selector.short === "string" ? selector.short : undefined,
                  usage_hint: typeof selector.usage_hint === "string" ? selector.usage_hint : undefined,
                  aliases: selectorAliases,
                  tags: selectorTags
                }
              : undefined,
          inject_mode: metadata.inject_mode === "append" ? "append" : "prepend",
          limits: undefined,
          summary: typeof metadata.summary === "string" ? metadata.summary : undefined,
          trust_tier:
            metadata.trust_tier === "certified" ||
            metadata.trust_tier === "popular" ||
            metadata.trust_tier === "standard" ||
            metadata.trust_tier === "untrusted"
              ? metadata.trust_tier
              : "untrusted",
          source_ref: typeof metadata.source_ref === "string" ? metadata.source_ref : undefined,
          popularity: typeof metadata.popularity === "object" && metadata.popularity !== null
            ? {
                uses: Math.max(0, Math.trunc(Number((metadata.popularity as Record<string, unknown>).uses || 0))),
                success_rate: Math.max(
                  0,
                  Math.min(1, Number((metadata.popularity as Record<string, unknown>).success_rate || 0))
                )
              }
            : { uses: 0, success_rate: 0 },
          repair_role: metadata.repair_role === "repair" ? "repair" : "normal"
        },
        body: parsed.body,
        path: skillPath,
        package: {
          root: dir,
          manifestPath: (await fileExists(manifestPath)) ? manifestPath : undefined,
          entrypoint: manifest.entrypoint,
          testCommand: manifest.testCommand,
          status: "active"
        }
      });
    } catch {
      // Skip malformed runtime skills to keep runtime resilient.
    }
  }

  return items;
}
