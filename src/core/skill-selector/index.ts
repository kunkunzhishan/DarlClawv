import { z } from "zod";
import type { AgentSpec, RunEvent, Skill } from "../../types/contracts.js";
import type { CodexSdkRuntimeClient } from "../../runtime/codex-sdk/client.js";

export type SkillSelectionResult = {
  selectedSkillIds: string[];
  mode: "llm" | "fallback";
  reason?: string;
};

const selectionSchema = z.object({
  selected_skill_ids: z.array(z.string()).default([]),
  reason: z.string().optional()
});

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueValidSkillIds(ids: string[], skillLibrary: Skill[]): string[] {
  const allowed = new Set(skillLibrary.map((skill) => skill.id));
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!allowed.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function mergeForcedSkillIds(selected: string[], forced: string[], skillLibrary: Skill[], maxSkills: number): string[] {
  const allowed = new Set(skillLibrary.map((skill) => skill.id));
  const out: string[] = [];
  const seen = new Set<string>();

  for (const id of [...forced, ...selected]) {
    if (!allowed.has(id) || seen.has(id)) {
      continue;
    }
    out.push(id);
    seen.add(id);
    if (out.length >= maxSkills) {
      break;
    }
  }
  return out;
}

function candidateJsonTexts(text: string): string[] {
  const out = new Set<string>();
  const trimmed = text.trim();
  if (trimmed) {
    out.add(trimmed);
  }

  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    out.add(fenced[1].trim());
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    out.add(text.slice(start, end + 1).trim());
  }

  return [...out];
}

function parseSelection(text: string, skillLibrary: Skill[]): SkillSelectionResult | null {
  for (const candidate of candidateJsonTexts(text)) {
    try {
      const raw = JSON.parse(candidate);
      const parsed = selectionSchema.safeParse(raw);
      if (!parsed.success) {
        continue;
      }
      return {
        selectedSkillIds: uniqueValidSkillIds(parsed.data.selected_skill_ids, skillLibrary),
        mode: "llm",
        reason: parsed.data.reason
      };
    } catch {
      // ignore malformed candidate
    }
  }
  return null;
}

function scoreSkill(taskLower: string, skill: Skill): number {
  let score = 0;

  const fields = [
    skill.id,
    skill.meta.description,
    skill.meta.summary || "",
    skill.meta.selector?.short || "",
    skill.meta.selector?.usage_hint || ""
  ].map((value) => value.toLowerCase());

  for (const field of fields) {
    if (!field) {
      continue;
    }
    if (taskLower.includes(field)) {
      score += 6;
      continue;
    }

    const tokens = field.split(/[^a-z0-9\u4e00-\u9fa5_-]+/).filter(Boolean);
    for (const token of tokens) {
      if (token.length <= 1) {
        continue;
      }
      if (taskLower.includes(token)) {
        score += 1;
      }
    }
  }

  const keywords = skill.meta.trigger.keywords || [];
  for (const keyword of keywords) {
    if (taskLower.includes(keyword.toLowerCase())) {
      score += 4;
    }
  }

  for (const alias of skill.meta.selector?.aliases || []) {
    if (taskLower.includes(alias.toLowerCase())) {
      score += 5;
    }
  }

  for (const tag of skill.meta.selector?.tags || []) {
    if (taskLower.includes(tag.toLowerCase())) {
      score += 2;
    }
  }

  if (skill.meta.repair_role === "repair") {
    score += 4;
  }

  const trustTier = skill.meta.trust_tier || "standard";
  if (trustTier === "certified") {
    score += 4;
  } else if (trustTier === "popular") {
    score += 2;
  } else if (trustTier === "untrusted") {
    score -= 2;
  }

  if (skill.meta.popularity) {
    score += Math.min(4, Math.floor(skill.meta.popularity.uses / 10));
    score += skill.meta.popularity.success_rate >= 0.8 ? 2 : 0;
  }

  return score;
}

export function fallbackSelectSkills(args: {
  task: string;
  skillLibrary: Skill[];
  maxSkills?: number;
  installIntent?: boolean;
  enforceSkillIds?: string[];
}): SkillSelectionResult {
  const maxSkills = args.maxSkills ?? 6;
  const taskLower = args.task.toLowerCase();
  const ranked = args.skillLibrary
    .map((skill) => ({ id: skill.id, score: scoreSkill(taskLower, skill) }))
    .sort((a, b) => b.score - a.score);
  const positive = ranked.filter((entry) => entry.score > 0).slice(0, maxSkills).map((entry) => entry.id);

  if (positive.length > 0) {
    const selected = mergeForcedSkillIds(positive, args.enforceSkillIds || [], args.skillLibrary, maxSkills);
    return {
      selectedSkillIds: selected,
      mode: "fallback",
      reason: "deterministic fallback ranking by task-skill overlap"
    };
  }

  const installIntentPick = args.installIntent
    ? args.skillLibrary
      .filter((skill) => skill.meta.repair_role === "repair")
      .sort((a, b) => {
        const order = (v: Skill["meta"]["trust_tier"]) =>
          v === "certified" ? 0 : v === "popular" ? 1 : v === "standard" ? 2 : 3;
        return order(a.meta.trust_tier) - order(b.meta.trust_tier);
      })
      .map((skill) => skill.id)
    : [];

  const fallbackPool = installIntentPick.length > 0
    ? installIntentPick
    : args.skillLibrary.slice(0, Math.min(maxSkills, 3)).map((skill) => skill.id);
  const selected = mergeForcedSkillIds(fallbackPool, args.enforceSkillIds || [], args.skillLibrary, maxSkills);

  return {
    selectedSkillIds: selected,
    mode: "fallback",
    reason: installIntentPick.length > 0
      ? "install-intent fallback prefers repair skills"
      : "no overlap found, using small default subset"
  };
}

function renderSkillForSelector(skill: Skill): string {
  const aliases = skill.meta.selector?.aliases && skill.meta.selector.aliases.length > 0
    ? skill.meta.selector.aliases.join(", ")
    : "none";
  const tags = skill.meta.selector?.tags && skill.meta.selector.tags.length > 0
    ? skill.meta.selector.tags.join(", ")
    : "none";
  const keywords = skill.meta.trigger.keywords && skill.meta.trigger.keywords.length > 0
    ? skill.meta.trigger.keywords.join(", ")
    : "none";

  return [
    `- id: ${skill.id}`,
    `  description: ${skill.meta.description}`,
    `  summary: ${skill.meta.summary || "none"}`,
    `  short: ${skill.meta.selector?.short || "none"}`,
    `  aliases: ${aliases}`,
    `  tags: ${tags}`,
    `  keywords: ${keywords}`,
    `  usage_hint: ${skill.meta.selector?.usage_hint || "none"}`,
    `  entrypoint: ${skill.package?.entrypoint || "none"}`
  ].join("\n");
}

function buildSelectorPrompt(args: {
  task: string;
  spec: AgentSpec;
  skillLibrary: Skill[];
  localMemorySummary?: string;
  globalMemorySummary?: string;
  maxSkills: number;
}): string {
  return [
    "[SYSTEM]",
    "You are a deterministic skill selector for a coding agent.",
    "Do not execute tools or commands. Decide only from provided text.",
    "",
    "[DEVELOPER]",
    "Return JSON only with this schema:",
    "{\"selected_skill_ids\": [\"<skill-id>\"], \"reason\": \"optional\"}",
    `Select at most ${args.maxSkills} skills from the catalog.`,
    "Only include ids that exist in the catalog. Prefer the minimal relevant set.",
    "Priority rule: certified/popular repair-capable skills > standard skills > untrusted skills.",
    "If the task implies install/setup/configure intent, include one repair-capable skill when available.",
    "",
    "[AGENT_SPEC]",
    `agent_id: ${args.spec.id}`,
    `agent_summary: ${args.spec.summary || "none"}`,
    `capability_policy: ${args.spec.capabilityPolicy}`,
    "",
    args.localMemorySummary ? `[LOCAL_MEMORY]\n${args.localMemorySummary}` : "",
    args.globalMemorySummary ? `[GLOBAL_MEMORY]\n${args.globalMemorySummary}` : "",
    "",
    "[SKILL_CATALOG]",
    args.skillLibrary.map((skill) => renderSkillForSelector(skill)).join("\n"),
    "",
    "[USER_TASK]",
    args.task
  ]
    .filter(Boolean)
    .join("\n");
}

export async function selectSkillsForTask(args: {
  task: string;
  spec: AgentSpec;
  skillLibrary: Skill[];
  sdkClient: CodexSdkRuntimeClient;
  maxSkills?: number;
  localMemorySummary?: string;
  globalMemorySummary?: string;
  onEvent?: (event: RunEvent) => void;
  installIntent?: boolean;
  enforceSkillIds?: string[];
}): Promise<SkillSelectionResult> {
  if (args.skillLibrary.length === 0) {
    return {
      selectedSkillIds: [],
      mode: "fallback",
      reason: "no skills available"
    };
  }

  const maxSkills = Math.max(1, Math.min(args.maxSkills ?? 6, 12));
  const prompt = buildSelectorPrompt({
    task: args.task,
    spec: args.spec,
    skillLibrary: args.skillLibrary,
    localMemorySummary: args.localMemorySummary,
    globalMemorySummary: args.globalMemorySummary,
    maxSkills
  });

  const thread = args.sdkClient.startThread();
  try {
    const turn = await args.sdkClient.runThread({
      thread,
      input: prompt,
      emitDeltaEvents: false,
      onEvent: args.onEvent
    });
    const parsed = parseSelection(turn.outputText, args.skillLibrary);
    if (parsed) {
      return {
        ...parsed,
        selectedSkillIds: mergeForcedSkillIds(
          parsed.selectedSkillIds.slice(0, maxSkills),
          args.enforceSkillIds || [],
          args.skillLibrary,
          maxSkills
        )
      };
    }
  } catch (error) {
    args.onEvent?.({
      type: "run.error",
      message: `skill selector failed: ${error instanceof Error ? error.message : String(error)}`,
      ts: nowIso()
    });
  }

  return fallbackSelectSkills({
    task: args.task,
    skillLibrary: args.skillLibrary,
    maxSkills,
    installIntent: args.installIntent,
    enforceSkillIds: args.enforceSkillIds
  });
}
