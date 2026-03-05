import path from "node:path";
import type { AppConfig, StrategyStatsRecord } from "../../types/contracts.js";
import { fileExists, readText, writeText } from "../../utils/fs.js";

type StrategyStatsDoc = {
  version: 1;
  records: StrategyStatsRecord[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptyDoc(): StrategyStatsDoc {
  return {
    version: 1,
    records: []
  };
}

export function resolveStrategyStatsPath(appConfig: AppConfig, agentId: string): string {
  return path.resolve(appConfig.memory.local_store_root, agentId, "strategy-stats.json");
}

export async function readStrategyStats(pathValue: string): Promise<StrategyStatsDoc> {
  if (!(await fileExists(pathValue))) {
    return emptyDoc();
  }
  try {
    const parsed = JSON.parse(await readText(pathValue)) as Partial<StrategyStatsDoc>;
    const records = Array.isArray(parsed?.records) ? parsed.records : [];
    return {
      version: 1,
      records: records.filter((item): item is StrategyStatsRecord => {
        return Boolean(
          item &&
          typeof item.skill_id === "string" &&
          typeof item.scenario_tag === "string" &&
          typeof item.attempts === "number" &&
          typeof item.successes === "number" &&
          typeof item.avg_latency_ms === "number" &&
          typeof item.updated_at === "string"
        );
      })
    };
  } catch {
    return emptyDoc();
  }
}

export function strategyBonusForSkill(args: {
  records: StrategyStatsRecord[];
  skillId: string;
  scenarioTag: string;
}): number {
  const exact = args.records.find((item) => item.skill_id === args.skillId && item.scenario_tag === args.scenarioTag);
  const fallback = args.records.find((item) => item.skill_id === args.skillId && item.scenario_tag === "general");
  const record = exact || fallback;
  if (!record || record.attempts <= 0) {
    return 0;
  }
  const successRate = record.successes / Math.max(1, record.attempts);
  const successBonus = successRate * 6;
  const sampleBonus = Math.min(3, Math.log2(record.attempts + 1));
  const latencyPenalty = Math.min(4, record.avg_latency_ms / 2000);
  return successBonus + sampleBonus - latencyPenalty;
}

export async function updateStrategyStats(args: {
  pathValue: string;
  skillId: string;
  scenarioTag: string;
  success: boolean;
  latencyMs: number;
  errorKind?: string;
}): Promise<StrategyStatsRecord> {
  const doc = await readStrategyStats(args.pathValue);
  const idx = doc.records.findIndex(
    (item) => item.skill_id === args.skillId && item.scenario_tag === args.scenarioTag
  );
  const prev: StrategyStatsRecord = idx >= 0
    ? doc.records[idx]
    : {
        skill_id: args.skillId,
        scenario_tag: args.scenarioTag,
        attempts: 0,
        successes: 0,
        avg_latency_ms: 0,
        updated_at: nowIso()
      };

  const attempts = prev.attempts + 1;
  const successes = prev.successes + (args.success ? 1 : 0);
  const safeLatency = Number.isFinite(args.latencyMs) && args.latencyMs > 0 ? args.latencyMs : 0;
  const avgLatency = attempts <= 1
    ? safeLatency
    : (prev.avg_latency_ms * prev.attempts + safeLatency) / attempts;

  const next: StrategyStatsRecord = {
    ...prev,
    attempts,
    successes,
    avg_latency_ms: Math.round(avgLatency),
    last_error_kind: args.errorKind,
    updated_at: nowIso()
  };

  if (idx >= 0) {
    doc.records[idx] = next;
  } else {
    doc.records.push(next);
  }
  await writeText(args.pathValue, `${JSON.stringify(doc, null, 2)}\n`);
  return next;
}
