import path from "node:path";
import { appendFile, readdir } from "node:fs/promises";
import type { EngineRunResult, RunEvent, RunRequest } from "../types/contracts.js";
import { ensureDir, readText, writeText } from "../utils/fs.js";
import { stringifyYaml } from "../utils/yaml.js";

const RUNS_DIR = path.resolve("runs");

export type RunContext = {
  runId: string;
  runDir: string;
};

export type RunSummary = {
  runId: string;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  status: "ok" | "failed" | "running";
  runnerPid?: number;
  exitCode?: number;
  failureKind?: "auth" | "network" | "model" | "tool" | "unknown";
  request: RunRequest;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function newRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readSummary(summaryPath: string): Promise<RunSummary> {
  const raw = await readText(summaryPath);
  return JSON.parse(raw) as RunSummary;
}

async function writeSummary(summaryPath: string, summary: RunSummary): Promise<void> {
  await writeText(summaryPath, JSON.stringify(summary, null, 2));
}

export async function createRun(request: RunRequest): Promise<RunContext> {
  const runId = newRunId();
  const runDir = path.join(RUNS_DIR, runId);
  await ensureDir(path.join(runDir, "snapshot"));

  const timestamp = nowIso();
  const summary: RunSummary = {
    runId,
    createdAt: timestamp,
    startedAt: timestamp,
    status: "running",
    request
  };

  await writeSummary(path.join(runDir, "summary.json"), summary);
  await writeText(path.join(runDir, "events.jsonl"), "");
  return { runId, runDir };
}

export async function appendEvent(ctx: RunContext, event: RunEvent): Promise<void> {
  const eventsPath = path.join(ctx.runDir, "events.jsonl");
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export async function writeSnapshot(ctx: RunContext, name: string, data: unknown): Promise<void> {
  const outPath = path.join(ctx.runDir, "snapshot", `${name}.yaml`);
  await writeText(outPath, stringifyYaml(data));
}

export async function patchSummary(ctx: RunContext, patch: Partial<RunSummary>): Promise<void> {
  const summaryPath = path.join(ctx.runDir, "summary.json");
  const current = await readSummary(summaryPath);
  const next = { ...current, ...patch } satisfies RunSummary;
  await writeSummary(summaryPath, next);
}

export async function finalizeRun(ctx: RunContext, result: EngineRunResult): Promise<void> {
  await patchSummary(ctx, {
    status: result.status,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    failureKind: result.failureKind
  });

  await writeText(path.join(ctx.runDir, "result.json"), JSON.stringify(result, null, 2));
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureDir(RUNS_DIR);
  const dirs = (await readdir(RUNS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const items: RunSummary[] = [];
  for (const dir of dirs) {
    try {
      const raw = await readText(path.join(RUNS_DIR, dir, "summary.json"));
      items.push(JSON.parse(raw) as RunSummary);
    } catch {
      // Ignore corrupted run summaries to keep viewer resilient.
    }
  }
  return items;
}

export async function getRunDetails(runId: string): Promise<{
  summary: RunSummary;
  events: RunEvent[];
  result: EngineRunResult | null;
} | null> {
  const runDir = path.join(RUNS_DIR, runId);
  try {
    const [summaryRaw, eventsRaw] = await Promise.all([
      readText(path.join(runDir, "summary.json")),
      readText(path.join(runDir, "events.jsonl"))
    ]);

    let result: EngineRunResult | null = null;
    try {
      result = JSON.parse(await readText(path.join(runDir, "result.json"))) as EngineRunResult;
    } catch {
      result = null;
    }

    const events = eventsRaw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);

    return {
      summary: JSON.parse(summaryRaw) as RunSummary,
      events,
      result
    };
  } catch {
    return null;
  }
}

export function toRunContext(runId: string): RunContext {
  return {
    runId,
    runDir: path.join(RUNS_DIR, runId)
  };
}
