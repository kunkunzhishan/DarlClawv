import path from "node:path";
import { z, ZodTypeAny } from "zod";
import {
  appConfigSchema,
  agentSchema,
  legacySkillYamlSchema,
  policySchema,
  skillFrontmatterSchema
} from "../types/schemas.js";
import { fileExists, listDirs, listFiles, readText } from "../utils/fs.js";
import { parseYaml } from "../utils/yaml.js";
import type { AgentProfile, AppConfig, Policy, Skill } from "../types/contracts.js";
import { loadAgentMarkdownLibrary, loadSkillMarkdownLibrary } from "./markdown-library.js";
import { loadSkillIndex, writeSkillIndex, type SkillIndexEntry } from "./skill-index.js";

type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

function validate<T>(schema: ZodTypeAny, data: unknown, filePath: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    throw new Error(`Config validation failed for ${filePath}: ${details}`);
  }
  return result.data as T;
}

async function readYamlFile<T>(schema: ZodTypeAny, filePath: string): Promise<T> {
  const raw = await readText(filePath);
  const parsed = parseYaml<unknown>(raw, filePath);
  return validate(schema, parsed, filePath);
}

function mergeUniqueStrings(...groups: Array<string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    if (!group) {
      continue;
    }
    for (const item of group) {
      const value = item.trim();
      if (value) {
        merged.add(value);
      }
    }
  }
  return [...merged];
}

function mergeSkill(base: Skill, markdownHint: Skill | undefined): Skill {
  if (!markdownHint) {
    return base;
  }

  const baseSelector = base.meta.selector;
  const hintSelector = markdownHint.meta.selector;
  const mergedSelector = baseSelector || hintSelector
    ? {
        short: hintSelector?.short ?? baseSelector?.short,
        usage_hint: hintSelector?.usage_hint ?? baseSelector?.usage_hint,
        aliases: mergeUniqueStrings(baseSelector?.aliases, hintSelector?.aliases),
        tags: mergeUniqueStrings(baseSelector?.tags, hintSelector?.tags)
      }
    : undefined;

  return {
    ...base,
    meta: {
      ...base.meta,
      trigger: {
        keywords: mergeUniqueStrings(base.meta.trigger.keywords, markdownHint.meta.trigger.keywords),
        file_globs: mergeUniqueStrings(base.meta.trigger.file_globs, markdownHint.meta.trigger.file_globs)
      },
      selector:
        mergedSelector && (
          Boolean(mergedSelector.short) ||
          Boolean(mergedSelector.usage_hint) ||
          mergedSelector.aliases.length > 0 ||
          mergedSelector.tags.length > 0
        )
          ? mergedSelector
          : undefined,
      summary: markdownHint.meta.summary ?? base.meta.summary,
      trust_tier: markdownHint.meta.trust_tier ?? base.meta.trust_tier,
      source_ref: markdownHint.meta.source_ref ?? base.meta.source_ref,
      popularity: markdownHint.meta.popularity ?? base.meta.popularity,
      repair_role: markdownHint.meta.repair_role ?? base.meta.repair_role
    }
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseSkillPackageManifest(raw: unknown): { entrypoint?: string; testCommand?: string } {
  const manifest = toRecord(raw);
  const commands = toRecord(manifest.commands);
  const entrypoint = toString(manifest.entrypoint) ?? toString(commands.run);
  const testCommand = toString(manifest.test) ?? toString(commands.test);
  return {
    entrypoint,
    testCommand
  };
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envNumber(name: string): number | undefined {
  const value = envString(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBoolean(name: string): boolean | undefined {
  const value = envString(name);
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(lower)) {
    return false;
  }
  return undefined;
}

function mergeSkillWithIndex(base: Skill, entry: SkillIndexEntry): Skill {
  const baseSelector = base.meta.selector;
  const mergedAliases = mergeUniqueStrings(baseSelector?.aliases, entry.aliases);
  const mergedTags = mergeUniqueStrings(baseSelector?.tags, entry.tags);
  const mergedSelector = {
    short: entry.short ?? baseSelector?.short,
    usage_hint: entry.usage_hint ?? baseSelector?.usage_hint,
    aliases: mergedAliases,
    tags: mergedTags
  };

  const packageInfo = {
    ...(base.package ?? { root: base.path }),
    status: entry.status,
    entrypoint: entry.entrypoint ?? base.package?.entrypoint,
    testCommand: entry.test_command ?? base.package?.testCommand,
    manifestPath: entry.manifest ?? base.package?.manifestPath
  };

  return {
    ...base,
    meta: {
      ...base.meta,
      selector:
        mergedSelector.short || mergedSelector.usage_hint || mergedSelector.aliases.length > 0 || mergedSelector.tags.length > 0
          ? mergedSelector
          : undefined,
      trust_tier: entry.trust_tier,
      source_ref: entry.source_ref ?? base.meta.source_ref,
      popularity: entry.popularity ?? base.meta.popularity,
      repair_role: entry.repair_role ?? base.meta.repair_role
    },
    package: packageInfo
  };
}

function parseFrontmatter(filePath: string, content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match || !match[1]) {
    throw new Error(`Skill contract violation in ${filePath}: SKILL.md requires YAML frontmatter with name/description`);
  }

  const frontmatter = parseYaml<Record<string, unknown>>(match[1], `${filePath}#frontmatter`);
  const body = content.slice(match[0].length).trim();
  if (!body) {
    throw new Error(`Skill contract violation in ${filePath}: SKILL.md body is required`);
  }
  return { frontmatter, body };
}

export async function loadAppConfig(configRoot = path.resolve("src/config")): Promise<AppConfig> {
  const appPath = path.join(configRoot, "app.yaml");
  if (!(await fileExists(appPath))) {
    throw new Error(`Missing app config: ${appPath}`);
  }
  const parsed = await readYamlFile<AppConfig>(appConfigSchema, appPath);
  return {
    ...parsed,
    agent: {
      default_id: parsed.agent?.default_id || parsed.default_agent || "default",
      config_root: parsed.agent?.config_root || "user/agents"
    },
    engine: {
      ...parsed.engine,
      provider: "codex-sdk",
      model: process.env.OPENAI_MODEL || parsed.engine.model,
      cli_command: process.env.MYDARL_CODEX_COMMAND || parsed.engine.cli_command || "codex",
      cli_args: parsed.engine.cli_args ?? [],
      codex_home: process.env.MYDARL_CODEX_HOME || parsed.engine.codex_home || ".darlclawv-runtime",
      timeout_ms: parsed.engine.timeout_ms ?? 120000
    },
    memory: {
      local_store_root: parsed.memory?.local_store_root || "user/memory/agents",
      global_vector_store_path:
        envString("MYDARL_MEMORY_GLOBAL_VECTOR_STORE_PATH") ??
        parsed.memory?.global_vector_store_path ??
        "user/memory/global/group-vector.json",
      vector: {
        dimension: envNumber("MYDARL_MEMORY_VECTOR_DIMENSION") ?? parsed.memory?.vector?.dimension ?? 96,
        personal_recall_top_k:
          envNumber("MYDARL_MEMORY_PERSONAL_RECALL_TOP_K") ?? parsed.memory?.vector?.personal_recall_top_k ?? 6,
        group_recall_top_k:
          envNumber("MYDARL_MEMORY_GROUP_RECALL_TOP_K") ?? parsed.memory?.vector?.group_recall_top_k ?? 6,
        compaction_similarity_threshold:
          envNumber("MYDARL_MEMORY_VECTOR_COMPACTION_SIMILARITY") ??
          parsed.memory?.vector?.compaction_similarity_threshold ??
          0.97,
        max_records: envNumber("MYDARL_MEMORY_VECTOR_MAX_RECORDS") ?? parsed.memory?.vector?.max_records ?? 5000,
        embedding: {
          provider:
            (envString("MYDARL_MEMORY_EMBEDDING_PROVIDER") as "deterministic" | "openai-compatible" | undefined) ??
            parsed.memory?.vector?.embedding?.provider ??
            "deterministic",
          base_url:
            envString("MYDARL_MEMORY_EMBEDDING_BASE_URL") ??
            parsed.memory?.vector?.embedding?.base_url ??
            "https://open.bigmodel.cn/api/paas/v4",
          model:
            envString("MYDARL_MEMORY_EMBEDDING_MODEL") ??
            parsed.memory?.vector?.embedding?.model ??
            "embedding-3",
          api_key_env:
            envString("MYDARL_MEMORY_EMBEDDING_API_KEY_ENV") ??
            parsed.memory?.vector?.embedding?.api_key_env ??
            "EMBEDDING_API_KEY",
          timeout_ms:
            envNumber("MYDARL_MEMORY_EMBEDDING_TIMEOUT_MS") ??
            parsed.memory?.vector?.embedding?.timeout_ms ??
            20000,
          fallback_to_deterministic:
            envBoolean("MYDARL_MEMORY_EMBEDDING_FALLBACK") ??
            parsed.memory?.vector?.embedding?.fallback_to_deterministic ??
            true
        },
        splitter: {
          enabled: envBoolean("MYDARL_MEMORY_SPLITTER_ENABLED") ?? parsed.memory?.vector?.splitter?.enabled ?? true,
          max_chars: envNumber("MYDARL_MEMORY_SPLITTER_MAX_CHARS") ?? parsed.memory?.vector?.splitter?.max_chars ?? 400,
          overlap_chars:
            envNumber("MYDARL_MEMORY_SPLITTER_OVERLAP_CHARS") ?? parsed.memory?.vector?.splitter?.overlap_chars ?? 60,
          min_chunk_chars:
            envNumber("MYDARL_MEMORY_SPLITTER_MIN_CHUNK_CHARS") ??
            parsed.memory?.vector?.splitter?.min_chunk_chars ??
            20
        }
      },
      temporary: {
        promote_threshold: envNumber("MYDARL_MEMORY_TEMP_PROMOTE_THRESHOLD") ?? parsed.memory?.temporary?.promote_threshold ?? 24,
        retain_after_promote:
          envNumber("MYDARL_MEMORY_TEMP_RETAIN_AFTER_PROMOTE") ?? parsed.memory?.temporary?.retain_after_promote ?? 12,
        max_entries: envNumber("MYDARL_MEMORY_TEMP_MAX_ENTRIES") ?? parsed.memory?.temporary?.max_entries ?? 200
      }
    },
    web: {
      autostart: parsed.web?.autostart ?? true,
      host: parsed.web?.host || "127.0.0.1",
      port: parsed.web?.port ?? 4789
    },
    workflow: {
      max_capability_attempts: parsed.workflow?.max_capability_attempts ?? 1,
      capability_timeout_ms: parsed.workflow?.capability_timeout_ms ?? 600000,
      enable_skill_manager: parsed.workflow?.enable_skill_manager ?? false,
      allow_promote_to_config_skills: parsed.workflow?.allow_promote_to_config_skills ?? true
    },
    security: {
      default_admin_cap: parsed.security?.default_admin_cap ?? "workspace",
      admin_stamp_path: parsed.security?.admin_stamp_path ?? "src/config/security/admin-steel-stamp.md"
    }
  };
}

export async function loadAgents(configRoot = path.resolve("src/config")): Promise<Map<string, AgentProfile>> {
  const dir = path.join(configRoot, "agents");
  const files = (await fileExists(dir))
    ? (await listFiles(dir)).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    : [];
  const [items, mdLibrary] = await Promise.all([
    Promise.all(files.map((file) => readYamlFile<AgentProfile>(agentSchema, file))),
    loadAgentMarkdownLibrary(configRoot)
  ]);
  const normalized = items.map((item) => ({
    ...item,
    default_skills: item.default_skills ?? [],
    constraints: item.constraints ?? [],
    keywords: item.keywords ?? []
  }));
  const merged = new Map<string, AgentProfile>(normalized.map((item) => [item.id, item]));
  for (const [id, mdAgent] of mdLibrary.entries()) {
    merged.set(id, mdAgent);
  }
  return merged;
}

export async function loadPolicies(configRoot = path.resolve("src/config")): Promise<Map<string, Policy>> {
  const dir = path.join(configRoot, "policies");
  const files = (await listFiles(dir)).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
  const items = await Promise.all(files.map((file) => readYamlFile<Policy>(policySchema, file)));
  const normalized = items.map((item) => ({
    ...item,
    sandbox: {
      mode: item.sandbox.mode,
      approval_policy: item.sandbox.approval_policy ?? "on-request"
    },
    network: {
      enabled: item.network.enabled ?? false
    }
  }));
  return new Map(normalized.map((item) => [item.id, item]));
}

export async function loadSkills(configRoot = path.resolve("src/config")): Promise<Map<string, Skill>> {
  const resolvedConfigRoot = path.resolve(configRoot);
  const defaultConfigRoot = path.resolve("src/config");
  const defaultUserSkillsRoot = path.resolve("user", "skills");
  const defaultSystemSkillsRoot = path.resolve("system", "skills");
  const legacyRoot = path.join(configRoot, "skills");

  const declaredRoots = (resolvedConfigRoot === defaultConfigRoot
    ? [
        process.env.MYDARL_USER_SKILLS_ROOT ? path.resolve(process.env.MYDARL_USER_SKILLS_ROOT) : defaultUserSkillsRoot,
        process.env.MYDARL_SYSTEM_SKILLS_ROOT
          ? path.resolve(process.env.MYDARL_SYSTEM_SKILLS_ROOT)
          : defaultSystemSkillsRoot
      ]
    : []
  ).filter(Boolean);
  const roots: string[] = [];
  for (const root of declaredRoots) {
    if (!roots.includes(root) && (await fileExists(root))) {
      roots.push(root);
    }
  }
  if ((await fileExists(legacyRoot)) && !roots.includes(legacyRoot)) {
    roots.push(legacyRoot);
  }

  const discoverSkillDirs = async (root: string): Promise<string[]> => {
    const levelOne = await listDirs(root);
    const discovered: string[] = [];
    for (const dir of levelOne) {
      if (await fileExists(path.join(dir, "SKILL.md"))) {
        discovered.push(dir);
        continue;
      }
      const levelTwo = await listDirs(dir);
      for (const child of levelTwo) {
        if (await fileExists(path.join(child, "SKILL.md"))) {
          discovered.push(child);
        }
      }
    }
    return discovered;
  };

  const dirs = (await Promise.all(roots.map((root) => discoverSkillDirs(root)))).flat();
  const [markdownLibrary, skillIndexDoc] = await Promise.all([
    loadSkillMarkdownLibrary(configRoot),
    loadSkillIndex(configRoot)
  ]);
  let indexDirty = false;

  const items = await Promise.all(
    dirs.map(async (dir) => {
      const bodyPath = path.join(dir, "SKILL.md");
      if (!(await fileExists(bodyPath))) {
        throw new Error(`Skill contract violation in ${dir}: requires SKILL.md`);
      }

      const raw = await readText(bodyPath);
      const parsedSkill = parseFrontmatter(bodyPath, raw);
      const frontmatter = validate<SkillFrontmatter>(
        skillFrontmatterSchema,
        parsedSkill.frontmatter,
        `${bodyPath}#frontmatter`
      );

      // Backward compatibility: allow metadata.yaml to override optional metadata fields.
      const legacyMetaPath = path.join(dir, "metadata.yaml");
      let legacyMeta: ReturnType<typeof legacySkillYamlSchema.parse> | undefined;
      if (await fileExists(legacyMetaPath)) {
        const legacyRaw = await readText(legacyMetaPath);
        legacyMeta = validate(legacySkillYamlSchema, parseYaml(legacyRaw, legacyMetaPath), legacyMetaPath);
      }

      const mergedTrigger = {
        ...(frontmatter.metadata?.trigger ?? {}),
        ...(legacyMeta?.trigger ?? {})
      };
      const manifestPath = path.join(dir, "manifest.yaml");
      const manifest = await fileExists(manifestPath)
        ? parseSkillPackageManifest(parseYaml(await readText(manifestPath), manifestPath))
        : {};

      return {
        id: frontmatter.name,
        meta: {
          name: frontmatter.name,
          description: frontmatter.description,
          protocol: "codex-skill-v1" as const,
          inject_mode: legacyMeta?.inject_mode ?? frontmatter.metadata.inject_mode,
          trigger: mergedTrigger,
          selector: legacyMeta?.selector ?? frontmatter.metadata?.selector,
          limits: legacyMeta?.limits ?? frontmatter.metadata?.limits,
          summary: legacyMeta?.summary ?? frontmatter.metadata?.summary,
          trust_tier: legacyMeta?.trust_tier ?? frontmatter.metadata?.trust_tier,
          source_ref: legacyMeta?.source_ref ?? frontmatter.metadata?.source_ref,
          popularity: legacyMeta?.popularity ?? frontmatter.metadata?.popularity,
          repair_role: legacyMeta?.repair_role ?? frontmatter.metadata?.repair_role
        },
        body: parsedSkill.body,
        path: dir,
        package: {
          root: dir,
          manifestPath: (await fileExists(manifestPath)) ? manifestPath : undefined,
          entrypoint: manifest.entrypoint,
          testCommand: manifest.testCommand,
          status: "active"
        }
      } satisfies Skill;
    })
  );
  const mergedWithMarkdown = items.map((item) => {
    const markdownHint = markdownLibrary.get(item.id);
    return mergeSkill(item, markdownHint);
  });
  const withIndex: Skill[] = [];
  for (const skill of mergedWithMarkdown) {
    const existingEntry = skillIndexDoc.data.skills[skill.id];
    const defaultEntry: SkillIndexEntry = {
      status: "active",
      short: skill.meta.selector?.short,
      aliases: skill.meta.selector?.aliases || [],
      tags: skill.meta.selector?.tags || [],
      usage_hint: skill.meta.selector?.usage_hint,
      entrypoint: skill.package?.entrypoint,
      test_command: skill.package?.testCommand,
      manifest: skill.package?.manifestPath,
      trust_tier: skill.meta.trust_tier || "standard",
      source_ref: skill.meta.source_ref,
      popularity: skill.meta.popularity || { uses: 0, success_rate: 0 },
      repair_role: skill.meta.repair_role || "normal"
    };
    if (!existingEntry) {
      skillIndexDoc.data.skills[skill.id] = defaultEntry;
      indexDirty = true;
    }

    const mergedSkill = mergeSkillWithIndex(skill, skillIndexDoc.data.skills[skill.id] || defaultEntry);
    const resolvedEntry = skillIndexDoc.data.skills[skill.id];
    if (resolvedEntry && mergedSkill.package) {
      let mutated = false;
      if (!resolvedEntry.entrypoint && mergedSkill.package.entrypoint) {
        resolvedEntry.entrypoint = mergedSkill.package.entrypoint;
        mutated = true;
      }
      if (!resolvedEntry.test_command && mergedSkill.package.testCommand) {
        resolvedEntry.test_command = mergedSkill.package.testCommand;
        mutated = true;
      }
      if (!resolvedEntry.manifest && mergedSkill.package.manifestPath) {
        resolvedEntry.manifest = mergedSkill.package.manifestPath;
        mutated = true;
      }
      if (mutated) {
        indexDirty = true;
      }
    }

    if ((mergedSkill.package?.status || "active") !== "disabled") {
      withIndex.push(mergedSkill);
    }
  }

  if (indexDirty) {
    await writeSkillIndex(skillIndexDoc);
  }

  return new Map(withIndex.map((item) => [item.id, item]));
}
