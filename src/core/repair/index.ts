import type { Skill, SkillRecommendedSource } from "../../types/contracts.js";

const INSTALL_INTENT_KEYWORDS = [
  "install",
  "setup",
  "configure",
  "missing capability",
  "missing tool",
  "missing mcp",
  "缺能力",
  "安装",
  "配置",
  "不可用"
];

export function isInstallIntentTask(task: string): boolean {
  const text = task.toLowerCase();
  return INSTALL_INTENT_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function findRepairSkillIds(skills: Skill[]): string[] {
  return skills.filter((skill) => skill.meta.repair_role === "repair").map((skill) => skill.id);
}

function trustRank(skill: Skill): number {
  const tier = skill.meta.trust_tier || "standard";
  if (tier === "certified") {
    return 0;
  }
  if (tier === "popular") {
    return 1;
  }
  if (tier === "standard") {
    return 2;
  }
  return 3;
}

export function sortSkillsByTrustAndPopularity(skills: Skill[]): Skill[] {
  return [...skills].sort((a, b) => {
    const byTrust = trustRank(a) - trustRank(b);
    if (byTrust !== 0) {
      return byTrust;
    }
    const aUses = a.meta.popularity?.uses || 0;
    const bUses = b.meta.popularity?.uses || 0;
    if (aUses !== bUses) {
      return bUses - aUses;
    }
    const aSuccess = a.meta.popularity?.success_rate || 0;
    const bSuccess = b.meta.popularity?.success_rate || 0;
    if (aSuccess !== bSuccess) {
      return bSuccess - aSuccess;
    }
    return a.id.localeCompare(b.id);
  });
}

export function classifyRepairPriorityLayer(skills: Skill[]): {
  layer: "certified-popular" | "standard" | "script-fallback";
  selectedSkillIds: string[];
} {
  const ordered = sortSkillsByTrustAndPopularity(skills);

  const tier1 = ordered.filter((skill) => {
    const trust = skill.meta.trust_tier || "standard";
    return trust === "certified" || trust === "popular";
  });
  if (tier1.length > 0) {
    return { layer: "certified-popular", selectedSkillIds: tier1.map((skill) => skill.id) };
  }

  const tier2 = ordered.filter((skill) => (skill.meta.trust_tier || "standard") === "standard");
  if (tier2.length > 0) {
    return { layer: "standard", selectedSkillIds: tier2.map((skill) => skill.id) };
  }

  return { layer: "script-fallback", selectedSkillIds: [] };
}

export function validateSkillSourceRef(args: {
  sourceRef?: string;
  recommendedSources: SkillRecommendedSource[];
}): { trusted: boolean; reason?: string } {
  if (!args.sourceRef) {
    return { trusted: false, reason: "missing source_ref" };
  }

  const sourceRef = args.sourceRef.trim();
  if (!sourceRef) {
    return { trusted: false, reason: "empty source_ref" };
  }

  const byId = args.recommendedSources.find((source) => source.enabled && source.id === sourceRef);
  if (byId) {
    return { trusted: true };
  }

  const byDomain = args.recommendedSources.find((source) => {
    if (!source.enabled || !source.domain) {
      return false;
    }
    return sourceRef.includes(source.domain);
  });
  if (byDomain) {
    return { trusted: true };
  }

  const byUrl = args.recommendedSources.find((source) => {
    if (!source.enabled || !source.url) {
      return false;
    }
    return sourceRef.startsWith(source.url);
  });
  if (byUrl) {
    return { trusted: true };
  }

  return { trusted: false, reason: `source_ref not in recommended_sources: ${sourceRef}` };
}

export function resolveRecommendedSourcesFromIndex(raw: unknown): SkillRecommendedSource[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: SkillRecommendedSource[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const kind = record.kind === "skill" || record.kind === "mcp" ? record.kind : null;
    if (!id || !kind) {
      continue;
    }
    out.push({
      id,
      kind,
      url: typeof record.url === "string" ? record.url : undefined,
      domain: typeof record.domain === "string" ? record.domain : undefined,
      trust_tier:
        record.trust_tier === "certified" ||
        record.trust_tier === "popular" ||
        record.trust_tier === "standard" ||
        record.trust_tier === "untrusted"
          ? record.trust_tier
          : "standard",
      enabled: record.enabled === false ? false : true
    });
  }
  return out;
}
