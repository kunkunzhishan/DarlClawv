import path from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { fileExists, readText, writeText } from "../utils/fs.js";
import { parseYaml, stringifyYaml } from "../utils/yaml.js";

const trustTierSchema = z.enum(["certified", "popular", "standard", "untrusted"]);

const recommendedSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["skill", "mcp"]),
  url: z.string().optional(),
  domain: z.string().optional(),
  trust_tier: trustTierSchema.default("standard"),
  enabled: z.boolean().default(true)
});

const skillIndexEntrySchema = z.object({
  status: z.enum(["active", "draft", "disabled"]).default("active"),
  short: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  usage_hint: z.string().optional(),
  entrypoint: z.string().optional(),
  test_command: z.string().optional(),
  manifest: z.string().optional(),
  trust_tier: trustTierSchema.default("standard"),
  source_ref: z.string().optional(),
  popularity: z
    .object({
      uses: z.number().int().nonnegative().default(0),
      success_rate: z.number().min(0).max(1).default(0)
    })
    .default({}),
  repair_role: z.enum(["normal", "repair"]).default("normal")
});

const skillIndexSchema = z.object({
  version: z.number().int().positive().default(1),
  updated_at: z.string().default(""),
  recommended_sources: z.array(recommendedSourceSchema).default([]),
  skills: z.record(skillIndexEntrySchema).default({})
});

export type SkillIndexEntry = z.infer<typeof skillIndexEntrySchema>;
export type SkillIndex = z.infer<typeof skillIndexSchema>;

export type SkillIndexDocument = {
  path: string;
  data: SkillIndex;
};

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSkillIndex(): SkillIndex {
  return {
    version: 1,
    updated_at: nowIso(),
    recommended_sources: [],
    skills: {}
  };
}

function normalizeForWrite(data: SkillIndex): SkillIndex {
  const sortedSkills = Object.entries(data.skills)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce<Record<string, SkillIndexEntry>>((acc, [id, entry]) => {
      acc[id] = entry;
      return acc;
    }, {});
  return {
    version: data.version,
    updated_at: data.updated_at || nowIso(),
    recommended_sources: data.recommended_sources,
    skills: sortedSkills
  };
}

export function resolveSkillIndexPath(configRoot = path.resolve("src/config")): string {
  if (process.env.MYDARL_SKILL_INDEX_PATH) {
    return path.resolve(process.env.MYDARL_SKILL_INDEX_PATH);
  }
  const resolvedConfigRoot = path.resolve(configRoot);
  const defaultConfigRoot = path.resolve("src/config");
  const legacyPath = path.join(configRoot, "skills", "index.yaml");
  if (resolvedConfigRoot !== defaultConfigRoot) {
    return legacyPath;
  }
  if (existsSync(legacyPath)) {
    return legacyPath;
  }
  return path.resolve(".darlclawv-runtime", "registry", "skills-index.yaml");
}

export async function loadSkillIndex(configRoot = path.resolve("src/config")): Promise<SkillIndexDocument> {
  const indexPath = resolveSkillIndexPath(configRoot);
  if (!(await fileExists(indexPath))) {
    return {
      path: indexPath,
      data: defaultSkillIndex()
    };
  }

  const raw = await readText(indexPath);
  const parsedRaw = parseYaml<unknown>(raw, indexPath);
  const parsed = skillIndexSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    throw new Error(`Config validation failed for ${indexPath}: ${details}`);
  }

  return {
    path: indexPath,
    data: parsed.data
  };
}

export async function writeSkillIndex(doc: SkillIndexDocument): Promise<void> {
  const normalized = normalizeForWrite({
    ...doc.data,
    updated_at: nowIso()
  });
  await writeText(doc.path, stringifyYaml(normalized));
}
