import { compileWorkerPrompt } from "../prompt-compiler/index.js";
import type { CodexSdkRuntimeClient } from "../../runtime/codex-sdk/client.js";
import type {
  AgentSpec,
  Policy,
  RecoveryDecision,
  RunEvent,
  Skill,
  TrustScope
} from "../../types/contracts.js";

function nowIso(): string {
  return new Date().toISOString();
}

function trustRank(tier: Skill["meta"]["trust_tier"]): number {
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

function isTrustAllowed(scope: TrustScope, tier: Skill["meta"]["trust_tier"]): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "certified-only") {
    return tier === "certified";
  }
  return tier === "certified" || tier === "popular";
}

function scenarioTagFromReason(reason: string): string {
  const lower = reason.toLowerCase();
  if (/(browse|browser|web|url|http|https)/i.test(lower)) {
    return "web-capability";
  }
  if (/(mcp|tool|server|binary|command not found|not found)/i.test(lower)) {
    return "missing-tool";
  }
  return "capability-repair";
}

function parseRecoverySuccess(output: string): { ok: boolean; summary: string } {
  const text = output.trim();
  const ok = /RECOVERY_STATUS:\s*repaired/i.test(text);
  const summaryMatch = text.match(/SUMMARY:\s*(.+)$/im);
  const summary = summaryMatch?.[1]?.trim() || text.slice(0, 240);
  return { ok, summary };
}

function buildRecoveryTask(args: {
  task: string;
  reason: string;
  skillId: string;
}): string {
  return [
    `Recovery mode with skill ${args.skillId}.`,
    `Original task: ${args.task}`,
    `Failure signal: ${args.reason}`,
    "Goal: restore missing capability with minimum changes, run one smoke test, then report result.",
    "Output format:",
    "RECOVERY_STATUS: repaired|failed",
    "SMOKE_TEST: <command>",
    "SMOKE_RESULT: pass|fail",
    "SUMMARY: <short summary>"
  ].join("\n");
}

function isHighRiskRecovery(args: { task: string; reason: string }): boolean {
  const source = `${args.task}\n${args.reason}`.toLowerCase();
  if (/(npm\s+install\s+-g|pip\s+install\s+--user|brew\s+install|apt(-get)?\s+install)/i.test(source)) {
    return true;
  }
  if (/(system\/skills|src\/config\/security|\/etc\/|\/usr\/local)/i.test(source)) {
    return true;
  }
  if (/(rm\s+-rf|chmod\s+777|chown\s+-r|danger-full-access|destructive)/i.test(source)) {
    return true;
  }
  return false;
}

export async function runRecoveryManager(args: {
  runId: string;
  task: string;
  reason: string;
  spec: AgentSpec;
  policy: Policy;
  skillLibrary: Skill[];
  sdkClient: CodexSdkRuntimeClient;
  maxAttempts: number;
  trustScope: TrustScope;
  riskyGateEnabled: boolean;
  askUserGate: (question: string) => Promise<boolean>;
  emitEvent: (event: RunEvent) => Promise<void>;
  emitStream?: (event: RunEvent) => void;
  runtimePathsHint?: string;
  localMemorySummary?: string;
  globalMemorySummary?: string;
}): Promise<RecoveryDecision> {
  const startedAt = Date.now();
  const scenarioTag = scenarioTagFromReason(args.reason);
  await args.emitEvent({
    type: "recovery.started",
    runId: args.runId,
    scenarioTag,
    reason: args.reason,
    ts: nowIso()
  });

  const repairCandidates = args.skillLibrary
    .filter((skill) => skill.meta.repair_role === "repair")
    .sort((a, b) => {
      const trustDelta = trustRank(a.meta.trust_tier) - trustRank(b.meta.trust_tier);
      if (trustDelta !== 0) {
        return trustDelta;
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(1, args.maxAttempts));

  if (repairCandidates.length === 0) {
    return {
      status: "not_repairable",
      scenarioTag,
      reason: "no repair skill available",
      elapsedMs: Date.now() - startedAt
    };
  }

  for (const candidate of repairCandidates) {
    const trustTier = candidate.meta.trust_tier || "standard";
    await args.emitEvent({
      type: "recovery.candidate.selected",
      runId: args.runId,
      skillId: candidate.id,
      trustTier,
      ts: nowIso()
    });

    if (!isTrustAllowed(args.trustScope, trustTier)) {
      if (!args.riskyGateEnabled) {
        continue;
      }
      const approved = await args.askUserGate(
        `Recovery candidate ${candidate.id} (${trustTier}) exceeds trust scope ${args.trustScope}. Approve risky repair? [y/N] `
      );
      if (!approved) {
        return {
          status: "need_user_gate",
          skillId: candidate.id,
          scenarioTag,
          reason: "risky recovery candidate rejected by user",
          elapsedMs: Date.now() - startedAt
        };
      }
    }
    if (args.riskyGateEnabled && isHighRiskRecovery({ task: args.task, reason: args.reason })) {
      const approved = await args.askUserGate(
        `Recovery action for ${candidate.id} looks high risk (system/global change). Approve risky recovery? [y/N] `
      );
      if (!approved) {
        return {
          status: "need_user_gate",
          skillId: candidate.id,
          scenarioTag,
          reason: "high-risk recovery action rejected by user",
          elapsedMs: Date.now() - startedAt
        };
      }
    }

    const prompt = compileWorkerPrompt({
      task: buildRecoveryTask({
        task: args.task,
        reason: args.reason,
        skillId: candidate.id
      }),
      policy: args.policy,
      spec: args.spec,
      skillLibrary: args.skillLibrary,
      selectedSkillIds: [candidate.id],
      runtimePathsHint: args.runtimePathsHint,
      localMemorySummary: args.localMemorySummary,
      globalMemorySummary: args.globalMemorySummary
    });

    const thread = args.sdkClient.startThread();
    const turn = await args.sdkClient.runThread({
      thread,
      input: prompt.fullText,
      emitDeltaEvents: false,
      onEvent: args.emitStream
    });
    const parsed = parseRecoverySuccess(turn.outputText || "");
    if (parsed.ok) {
      await args.emitEvent({
        type: "recovery.test.passed",
        runId: args.runId,
        skillId: candidate.id,
        summary: parsed.summary,
        ts: nowIso()
      });
      await args.emitEvent({
        type: "recovery.finished",
        runId: args.runId,
        status: "repaired",
        summary: parsed.summary,
        ts: nowIso()
      });
      return {
        status: "repaired",
        skillId: candidate.id,
        scenarioTag,
        summary: parsed.summary,
        elapsedMs: Date.now() - startedAt
      };
    }

    await args.emitEvent({
      type: "recovery.test.failed",
      runId: args.runId,
      skillId: candidate.id,
      reason: parsed.summary || "repair output invalid",
      ts: nowIso()
    });
  }

  const reason = "repair attempts exhausted";
  await args.emitEvent({
    type: "recovery.finished",
    runId: args.runId,
    status: "not_repairable",
    summary: reason,
    ts: nowIso()
  });
  return {
    status: "not_repairable",
    scenarioTag,
    reason,
    elapsedMs: Date.now() - startedAt
  };
}
