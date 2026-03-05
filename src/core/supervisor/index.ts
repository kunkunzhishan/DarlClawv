import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { compileWorkerPrompt } from "../prompt-compiler/index.js";
import { fallbackSelectSkills } from "../skill-selector/index.js";
import { toRuntimePermission, minProfile } from "../security/permissions.js";
import { createOrchestrator } from "../orchestrator/index.js";
import { runRecoveryManager } from "../recovery/manager.js";
import { extractSelfReport } from "../iteration/worker-report.js";
import {
  appendGroupVectorMemories,
  appendPersonalVectorMemories,
  appendTemporaryContext,
  compactVectorMemories,
  countTemporaryContext,
  readTemporaryContext,
  recallLayeredMemory,
  retainTemporaryContext,
  resolveMemoryPaths,
  resolveMemoryRuntimeOptions,
  summarizeLayeredGroupMemory,
  summarizeLayeredLocalMemory
} from "../memory/store.js";
import {
  readStrategyStats,
  resolveStrategyStatsPath,
  updateStrategyStats
} from "../strategy/stats.js";
import { initWorkflowState, setThreadBinding, setWorkflowPhase } from "../workflow/session.js";
import { loadAgentSpec } from "../../registry/agent-spec.js";
import { loadAppConfig, loadPolicies, loadSkills } from "../../registry/index.js";
import { loadSkillIndex } from "../../registry/skill-index.js";
import { ensureRuntimeLibrary } from "../../runtime/library/index.js";
import { appendEvent, createRun, finalizeRun, writeSnapshot } from "../../storage/index.js";
import { decidePermissionByAdmin } from "../security/admin-approver.js";
import type {
  AgentSpec,
  AutonomyProfile,
  EngineRunResult,
  PermissionProfile,
  Policy,
  RecoveryDecision,
  RunEvent,
  RunMode,
  RunRequest,
  Skill,
  WorkerTurnContext
} from "../../types/contracts.js";
import { CodexSdkRuntimeClient } from "../../runtime/codex-sdk/client.js";

function nowIso(): string {
  return new Date().toISOString();
}

function inferControlPlaneRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return process.cwd();
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function summarizeResultForMemory(result: EngineRunResult): string {
  const base = (result.outputText || result.error || "").trim();
  return base.length > 1000 ? `${base.slice(0, 1000)}...` : base;
}

function sanitizeUserFacingOutput(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim();
      if (!normalized) {
        return true;
      }
      if (/^\{"type":"PERMISSION_REQUEST"/.test(normalized)) {
        return false;
      }
      if (/^RECOVERY_STATUS:/i.test(normalized)) {
        return false;
      }
      if (/^SMOKE_TEST:/i.test(normalized)) {
        return false;
      }
      if (/^SMOKE_RESULT:/i.test(normalized)) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
}

function summarizeCycleEvents(events: RunEvent[]): { summary: string; runtimeErrors: string[] } {
  const errors: string[] = [];
  const stderr: string[] = [];
  const toolFailures: string[] = [];
  const exitCodes: number[] = [];

  for (const event of events) {
    if (event.type === "run.error") {
      errors.push(event.message);
    } else if (event.type === "runner.stderr") {
      stderr.push(event.line);
    } else if (event.type === "runner.exited" && event.code !== 0) {
      exitCodes.push(event.code);
    } else if (event.type === "tool.result" && !event.ok) {
      toolFailures.push(event.name);
    }
  }

  const summaryParts: string[] = [];
  if (errors.length > 0) {
    summaryParts.push(`runtime errors: ${errors.slice(-3).join(" | ")}`);
  }
  if (exitCodes.length > 0) {
    summaryParts.push(`command exit codes: ${exitCodes.join(", ")}`);
  }
  if (stderr.length > 0) {
    summaryParts.push(`stderr: ${stderr.slice(-3).join(" | ")}`);
  }
  if (toolFailures.length > 0) {
    summaryParts.push(`tool failures: ${toolFailures.slice(-3).join(", ")}`);
  }

  return {
    summary: summaryParts.length > 0 ? summaryParts.join("\n") : "none",
    runtimeErrors: errors
  };
}

function classifyBlocker(args: {
  rawOutput: string;
  errorReason?: string;
  runtimeErrors?: string[];
  currentProfile: PermissionProfile;
}): { kind: "permission" | "capability" | "environment" | "none"; reason: string } {
  const source = [
    args.rawOutput,
    args.errorReason || "",
    ...(args.runtimeErrors || [])
  ]
    .join("\n")
    .toLowerCase();
  const sourceRaw = [
    args.rawOutput,
    args.errorReason || "",
    ...(args.runtimeErrors || [])
  ].join("\n");

  if (/(stream disconnected|error sending request for url .*\/responses|api\.openai\.com\/v1\/responses|turn failed)/i.test(source)) {
    return { kind: "environment", reason: "model endpoint unavailable or unreachable" };
  }

  const hasNetworkSignal = /(could not resolve host|getaddrinfo enotfound|network is unreachable|econnrefused|etimedout|bad gateway|dns|connection error)/i.test(
    source
  );
  const hasNetworkSignalZh = /(无法访问|不能访问|无法联网|网络受限|外部网络|网络被禁用|网络已禁用|无法连接|连接失败|无法解析|域名解析失败|无法打开网页|无法打开网站)/.test(
    sourceRaw
  );
  if (hasNetworkSignal || hasNetworkSignalZh) {
    if (args.currentProfile !== "full") {
      return { kind: "permission", reason: "network access requires a higher runtime profile" };
    }
    return { kind: "environment", reason: "external network or DNS unavailable" };
  }
  if (/(operation not permitted|eacces|eperm|permission denied|approval policy|approval policy is never)/i.test(source)) {
    return { kind: "permission", reason: "permission denied by runtime sandbox/policy" };
  }
  if (/(command not found|not found\n|missing capability|mcp.*unavailable|no such file or directory)/i.test(source)) {
    return { kind: "capability", reason: "required tool/capability missing" };
  }
  return { kind: "none", reason: "" };
}

function scenarioTagFromTask(task: string): string {
  const text = task.toLowerCase();
  if (/(https?:\/\/|网页|网站|web|browse|browser|api)/i.test(text)) {
    return "web-task";
  }
  if (/(install|setup|配置|mcp|tool|技能|skill)/i.test(text)) {
    return "setup-task";
  }
  return "general";
}

function requestedProfileFromFailure(args: {
  reason: string;
  rawOutput: string;
  currentProfile: PermissionProfile;
}): PermissionProfile {
  const source = `${args.reason}\n${args.rawOutput}`.toLowerCase();
  if (/(npm install -g|apt|brew|system|network|https?:\/\/)/i.test(source)) {
    return "full";
  }
  if (/(write|edit|create|workspace|install)/i.test(source)) {
    return args.currentProfile === "safe" ? "workspace" : "full";
  }
  return args.currentProfile === "safe" ? "workspace" : "full";
}

function autonomyCycleBudget(profile: AutonomyProfile, configured: number): number {
  if (profile === "tight") {
    return Math.max(1, Math.min(configured, 3));
  }
  if (profile === "balanced") {
    return Math.max(2, Math.min(configured, 6));
  }
  return Math.max(3, configured);
}

function profileFromPolicy(policy: Policy): PermissionProfile {
  if (policy.sandbox.mode === "danger-full-access") {
    return "full";
  }
  if (policy.sandbox.mode === "workspace-write") {
    return "workspace";
  }
  return "safe";
}

function policyFromProfile(profile: PermissionProfile): Policy {
  const runtime = toRuntimePermission(profile);
  return {
    id: `runtime-${profile}`,
    sandbox: {
      mode: runtime.sandboxMode,
      approval_policy: runtime.approvalPolicy
    },
    network: {
      enabled: runtime.networkAccessEnabled
    }
  };
}

const profileRank: Record<PermissionProfile, number> = {
  safe: 0,
  workspace: 1,
  full: 2
};

function isHigherProfile(a: PermissionProfile, b: PermissionProfile): boolean {
  return profileRank[a] > profileRank[b];
}

function clampProfile(profile: PermissionProfile, limit: PermissionProfile): PermissionProfile {
  return minProfile(profile, limit);
}

function filterAllowedSkillIds(ids: string[], skillLibrary: Skill[], maxSkills: number): string[] {
  const allowed = new Set(skillLibrary.map((skill) => skill.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!allowed.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= maxSkills) {
      break;
    }
  }
  return out;
}

function mergeSkillIds(primary: string[], extra: string[], maxSkills: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...primary, ...extra]) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= maxSkills) {
      break;
    }
  }
  return out;
}

async function askUserEscalation(args: {
  requestedProfile: PermissionProfile;
  reason: string;
}): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Permission escalation required: profile=${args.requestedProfile}. Reason: ${args.reason}. Approve? [y/N] `
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export type RunTaskHooks = {
  onEvent?: (event: RunEvent) => void;
};

export async function runTask(
  request: RunRequest,
  hooks?: RunTaskHooks
): Promise<{ runId: string; result: EngineRunResult }> {
  const controlPlaneRoot = path.resolve(
    request.controlPlaneRoot || process.env.MYDARL_CONTROL_PLANE_ROOT || inferControlPlaneRoot()
  );
  const configRoot = path.resolve(controlPlaneRoot, "src/config");
  const configSkillsRoot = path.resolve(configRoot, "skills");

  const appConfig = await loadAppConfig(configRoot);

  const [configSkills, policies, skillIndexDoc] = await Promise.all([
    loadSkills(configRoot),
    loadPolicies(configRoot),
    loadSkillIndex(configRoot)
  ]);
  const recommendedSources = skillIndexDoc.data.recommended_sources || [];

  const resolvedAgentId = request.agentId || appConfig.agent.default_id || appConfig.default_agent || "default";

  let executionSpec: AgentSpec;
  try {
    executionSpec = await loadAgentSpec(resolvedAgentId, path.resolve(controlPlaneRoot, appConfig.agent.config_root));
  } catch {
    throw new Error(
      `Agent spec not found for '${resolvedAgentId}'. Expected file: ${appConfig.agent.config_root}/${resolvedAgentId}/agent.md`
    );
  }

  const policyId = request.policyId || appConfig.default_policy;
  const configuredPolicy = policies.get(policyId);
  if (!configuredPolicy) {
    throw new Error(`Policy not found: ${policyId}`);
  }
  const runMode: RunMode = request.runMode ?? "managed";
  const adminCap: PermissionProfile = request.adminCap ?? appConfig.security.default_admin_cap;
  let currentProfile = minProfile(profileFromPolicy(configuredPolicy), adminCap);
  let currentPolicy = policyFromProfile(currentProfile);

  const taskWorkspace = path.resolve(request.taskWorkspace || process.cwd());
  const workspaceInsideControlPlane = isPathInsideRoot(taskWorkspace, controlPlaneRoot);
  const allowControlPlaneSkillWrites = workspaceInsideControlPlane;

  const ctx = await createRun({
    ...request,
    agentId: resolvedAgentId,
    taskWorkspace,
    controlPlaneRoot
  });

  const emit = async (event: RunEvent): Promise<void> => {
    hooks?.onEvent?.(event);
    await appendEvent(ctx, event);
  };

  let writeChain: Promise<void> = Promise.resolve();
  let cycleEvents: RunEvent[] | null = null;
  const emitStream = (event: RunEvent): void => {
    hooks?.onEvent?.(event);
    if (cycleEvents) {
      cycleEvents.push(event);
    }
    writeChain = writeChain.then(async () => appendEvent(ctx, event)).catch(() => undefined);
  };

  await emit({ type: "run.started", runId: ctx.runId, ts: nowIso() });

  const memoryPaths = resolveMemoryPaths(appConfig, resolvedAgentId);
  const memoryOptions = resolveMemoryRuntimeOptions(appConfig);
  const layeredMemory = await recallLayeredMemory({
    paths: memoryPaths,
    query: request.task,
    options: memoryOptions,
    temporaryLimit: memoryOptions.temporaryMaxEntries
  });
  const localMemorySummary = summarizeLayeredLocalMemory(layeredMemory);
  const globalMemorySummary = summarizeLayeredGroupMemory(layeredMemory);

  await Promise.all([
    writeSnapshot(ctx, "app", appConfig),
    writeSnapshot(ctx, "policy", configuredPolicy),
    writeSnapshot(ctx, "agent", executionSpec),
    writeSnapshot(
      ctx,
      "skills",
      [...configSkills.values()].map((skill) => ({
        id: skill.id,
        description: skill.meta.description,
        summary: skill.meta.summary
      }))
    ),
    writeSnapshot(ctx, "recommended-sources", recommendedSources),
    writeSnapshot(ctx, "request", request),
    writeSnapshot(ctx, "runtime-context", {
      taskWorkspace,
      controlPlaneRoot,
      workspaceInsideControlPlane,
      allowControlPlaneSkillWrites,
      runMode,
      adminCap,
      initialWorkerProfile: currentProfile
    })
  ]);

  let orchestrator: ReturnType<typeof createOrchestrator> | null = null;
  try {
    orchestrator = createOrchestrator(appConfig);
  } catch (orchestratorError) {
    await emit({
      type: "run.error",
      message: `orchestrator init failed: ${orchestratorError instanceof Error ? orchestratorError.message : String(orchestratorError)}`,
      ts: nowIso()
    });
  }

  const workflow = await initWorkflowState({
    ctx,
    request: { ...request, agentId: resolvedAgentId, taskWorkspace, controlPlaneRoot },
    timeoutMs: appConfig.workflow.timeout_ms
  });
  await writeSnapshot(ctx, "workflow", workflow);
  await emit({ type: "workflow.started", workflowId: workflow.workflowId, ts: nowIso() });

  const autonomyProfile = request.autonomyProfile ?? appConfig.workflow.autonomy_profile;
  const maxSelfIterCycles = autonomyCycleBudget(autonomyProfile, appConfig.workflow.max_self_iter_cycles ?? 6);
  const maxPermissionAttempts = appConfig.workflow.max_permission_attempts ?? 3;
  const maxRepairAttempts = appConfig.workflow.max_repair_attempts ?? 4;
  const maxTotalMs = (appConfig.workflow.max_total_minutes ?? 20) * 60 * 1000;
  const runStartedAt = Date.now();
  const strategyStatsPath = resolveStrategyStatsPath(appConfig, resolvedAgentId);
  const strategyStatsDoc = await readStrategyStats(strategyStatsPath);
  const runScenarioTag = scenarioTagFromTask(request.task);

  let nextMainTask = request.task;
  let finalOutput = "";
  let usage: EngineRunResult["usage"] | undefined;
  let status: EngineRunResult["status"] = "ok";
  let failureKind: EngineRunResult["failureKind"] | undefined;
  let error: string | undefined;
  let lastTurnContext: WorkerTurnContext | null = null;
  let permissionAttempts = 0;
  let repairAttempts = 0;
  let emptyResponseStreak = 0;

  const runtimePaths = await ensureRuntimeLibrary();
  const runtimeRoot = path.resolve(runtimePaths.root);
  const runtimePathsHint = [
    `runtime_root: ${runtimeRoot}`,
    `mcp_runtime_root: ${runtimePaths.mcpDir}`,
    "For MCP/tool virtualenvs and runtime artifacts, write under mcp_runtime_root instead of project-root .venv-* paths."
  ].join("\n");
  const mergedSkillLibrary = (): Skill[] => {
    const byId = new Map<string, Skill>();
    for (const skill of configSkills.values()) {
      if (!byId.has(skill.id)) {
        byId.set(skill.id, skill);
      }
    }
    return [...byId.values()];
  };
  const mainAdditionalDirectories = [configSkillsRoot, runtimeRoot]
    .filter((dir, idx, all) => all.indexOf(dir) === idx && existsSync(dir));

  let mainSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    ...toRuntimePermission(currentProfile),
    skipGitRepoCheck: true,
    additionalDirectories: mainAdditionalDirectories
  });
  const adminSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    ...toRuntimePermission("safe"),
    skipGitRepoCheck: true,
    additionalDirectories: mainAdditionalDirectories
  });

  const rebuildMainWorker = (profile: PermissionProfile): void => {
    currentProfile = profile;
    currentPolicy = policyFromProfile(profile);
    mainSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
      workingDirectory: taskWorkspace,
      ...toRuntimePermission(profile),
      skipGitRepoCheck: true,
      additionalDirectories: mainAdditionalDirectories
    });
    mainThread = mainSdkClient.startThread();
    mainThreadBound = false;
  };

  let mainThread = workflow.threadBindings.main
    ? mainSdkClient.resumeThread(workflow.threadBindings.main)
    : mainSdkClient.startThread();
  let mainThreadBound = Boolean(workflow.threadBindings.main);

  if (workflow.threadBindings.main) {
    await emit({
      type: "thread.resumed",
      role: "main",
      threadId: workflow.threadBindings.main,
      ts: nowIso()
    });
  }

  await setWorkflowPhase(ctx, "running-main");
  await emit({
    type: "workflow.phase.changed",
    workflowId: workflow.workflowId,
    phase: "running-main",
    ts: nowIso()
  });

  const decidePermission = async (permissionRequest: { requested_profile: PermissionProfile; reason: string }) => {
    if (isHigherProfile(permissionRequest.requested_profile, adminCap)) {
      return {
        decision: "escalate" as const,
        profile: permissionRequest.requested_profile,
        reason: "requested profile exceeds admin cap"
      };
    }

    if (runMode !== "managed") {
      return {
        decision: "escalate" as const,
        profile: permissionRequest.requested_profile,
        reason: "direct mode bypasses admin and requires user approval"
      };
    }

    const adminDecision = await decidePermissionByAdmin({
      sdkClient: adminSdkClient,
      task: request.task,
      request: { type: "PERMISSION_REQUEST", ...permissionRequest },
      adminCap,
      steelStampPath: appConfig.security.admin_stamp_path,
      onEvent: emitStream
    });

    if (adminDecision.decision === "grant") {
      const clamped = clampProfile(adminDecision.profile, adminCap);
      const finalProfile = clampProfile(clamped, permissionRequest.requested_profile);
      return {
        decision: "grant" as const,
        profile: finalProfile,
        reason: adminDecision.reason
      };
    }
    if (adminDecision.decision === "escalate") {
      return {
        decision: "escalate" as const,
        profile: permissionRequest.requested_profile,
        reason: adminDecision.reason
      };
    }
    return {
      decision: "deny" as const,
      profile: permissionRequest.requested_profile,
      reason: adminDecision.reason
    };
  };

  const applyPermissionDecision = async (permissionRequest: { requested_profile: PermissionProfile; reason: string }) => {
    permissionAttempts += 1;
    if (permissionAttempts > maxPermissionAttempts) {
      status = "failed";
      failureKind = "tool";
      error = `permission attempts exceeded budget (${maxPermissionAttempts})`;
      return false;
    }

    await emit({
      type: "permission.requested",
      runId: ctx.runId,
      requestedProfile: permissionRequest.requested_profile,
      reason: permissionRequest.reason,
      ts: nowIso()
    });

    const adminDecision = await decidePermission(permissionRequest);
    await emit({
      type: "permission.admin.decided",
      runId: ctx.runId,
      decision: adminDecision.decision,
      requestedProfile: permissionRequest.requested_profile,
      grantedProfile: adminDecision.profile,
      reason: adminDecision.reason,
      ts: nowIso()
    });

    if (adminDecision.decision === "grant") {
      rebuildMainWorker(adminDecision.profile);
      nextMainTask = [
        nextMainTask,
        `Permission granted: ${adminDecision.profile}`,
        `Reason: ${adminDecision.reason}`
      ].join("\n");
      return true;
    }
    if (adminDecision.decision === "deny") {
      status = "failed";
      failureKind = "tool";
      error = `Permission denied by admin: ${adminDecision.reason}`;
      return false;
    }

    const approved = await askUserEscalation({
      requestedProfile: adminDecision.profile,
      reason: adminDecision.reason
    });
    await emit({
      type: "permission.user.decided",
      runId: ctx.runId,
      approved,
      requestedProfile: permissionRequest.requested_profile,
      grantedProfile: approved ? adminDecision.profile : undefined,
      reason: approved ? "approved by user escalation" : "rejected by user",
      ts: nowIso()
    });
    if (!approved) {
      status = "failed";
      failureKind = "tool";
      error = `User rejected permission escalation for profile ${permissionRequest.requested_profile}`;
      return false;
    }

    rebuildMainWorker(adminDecision.profile);
    nextMainTask = [
      nextMainTask,
      `Permission granted: ${adminDecision.profile}`,
      `Reason: ${adminDecision.reason}`
    ].join("\n");
    return true;
  };

  for (let cycle = 1; cycle <= maxSelfIterCycles; cycle += 1) {
    if (Date.now() - runStartedAt > maxTotalMs) {
      status = "failed";
      failureKind = "tool";
      error = `run time budget exceeded (${appConfig.workflow.max_total_minutes ?? 20} minutes)`;
      await emit({
        type: "run.error",
        message: error,
        ts: nowIso()
      });
      break;
    }

    await emit({ type: "iteration.started", runId: ctx.runId, cycle, ts: nowIso() });

    const allSkills = mergedSkillLibrary();
    const candidateSkills = executionSpec.skillWhitelist.length > 0
      ? allSkills.filter((skill) => executionSpec.skillWhitelist.includes(skill.id))
      : allSkills;
    const selected = fallbackSelectSkills({
      task: nextMainTask,
      skillLibrary: candidateSkills,
      maxSkills: 6,
      strategy: {
        records: strategyStatsDoc.records,
        scenarioTag: runScenarioTag
      }
    });

    await emit({
      type: "skills.selected",
      agentId: resolvedAgentId,
      selectedSkillIds: selected.selectedSkillIds,
      mode: selected.mode,
      reason: selected.reason,
      ts: nowIso()
    });

    const prompt = compileWorkerPrompt({
      task: nextMainTask,
      policy: currentPolicy,
      spec: executionSpec,
      skillLibrary: allSkills,
      selectedSkillIds: selected.selectedSkillIds,
      runtimePathsHint,
      localMemorySummary,
      globalMemorySummary
    });
    await emit({ type: "prompt.compiled", size: prompt.size, ts: nowIso() });

    cycleEvents = [];
    let mainTurn;
    let cycleError: string | undefined;
    try {
      mainTurn = await mainSdkClient.runThread({
        thread: mainThread,
        input: prompt.fullText,
        onEvent: emitStream
      });
    } catch (runError) {
      cycleError = runError instanceof Error ? runError.message : String(runError);
    }

    if (mainTurn && !mainThreadBound && mainTurn.threadId) {
      await setThreadBinding({ ctx, role: "main", threadId: mainTurn.threadId });
      await emit({
        type: "thread.created",
        role: "main",
        threadId: mainTurn.threadId,
        ts: nowIso()
      });
      mainThreadBound = true;
    }

    usage = mainTurn?.usage ?? usage;
    const rawOutput = (mainTurn?.outputText || "").trim();
    const { report, userFacingOutput } = extractSelfReport(rawOutput);
    const outputForUser = sanitizeUserFacingOutput(userFacingOutput || rawOutput);
    const { summary, runtimeErrors } = summarizeCycleEvents(cycleEvents);
    cycleEvents = null;
    lastTurnContext = {
      cycle,
      maxCycles: maxSelfIterCycles,
      instruction: nextMainTask,
      workerOutput: rawOutput,
      userFacingOutput: outputForUser,
      errorReason: cycleError || report.errorReason || runtimeErrors[0],
      thinking: report.thinking,
      nextAction: report.nextAction,
      eventSummary: summary,
      runtimeErrors
    };

    await emit({ type: "iteration.worker.completed", runId: ctx.runId, cycle, ts: nowIso() });

    const blocker = classifyBlocker({
      rawOutput,
      errorReason: lastTurnContext.errorReason,
      runtimeErrors,
      currentProfile
    });
    if (blocker.kind !== "none") {
      await emit({
        type: "execution.blocked",
        runId: ctx.runId,
        kind: blocker.kind,
        reason: blocker.reason,
        ts: nowIso()
      });
    }

    if (blocker.kind === "environment") {
      status = "failed";
      failureKind = "network";
      error = `Environment blocked execution: ${blocker.reason}`;
      finalOutput = outputForUser;
      break;
    }

    if (blocker.kind === "permission") {
      const requestedProfile = requestedProfileFromFailure({
        reason: blocker.reason,
        rawOutput,
        currentProfile
      });
      if (!isHigherProfile(requestedProfile, currentProfile)) {
        status = "failed";
        failureKind = "tool";
        error = `Permission still insufficient at profile=${currentProfile}`;
        finalOutput = outputForUser;
        break;
      }
      const ok = await applyPermissionDecision({
        requested_profile: requestedProfile,
        reason: blocker.reason
      });
      if (!ok) {
        finalOutput = outputForUser;
        break;
      }
      continue;
    }

    if (blocker.kind === "capability") {
      repairAttempts += 1;
      if (repairAttempts > maxRepairAttempts) {
        status = "failed";
        failureKind = "tool";
        error = `repair attempts exceeded budget (${maxRepairAttempts})`;
        finalOutput = outputForUser;
        break;
      }

      let recovery: RecoveryDecision;
      try {
        recovery = await runRecoveryManager({
          runId: ctx.runId,
          task: request.task,
          reason: lastTurnContext.errorReason || blocker.reason,
          spec: executionSpec,
          policy: currentPolicy,
          skillLibrary: allSkills,
          sdkClient: mainSdkClient,
          maxAttempts: maxRepairAttempts,
          trustScope: appConfig.security.trust_scope,
          riskyGateEnabled: appConfig.evolution.risky_gate_enabled,
          askUserGate: askYesNo,
          emitEvent: emit,
          emitStream,
          runtimePathsHint,
          localMemorySummary,
          globalMemorySummary
        });
      } catch (repairError) {
        status = "failed";
        failureKind = "tool";
        error = `recovery failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`;
        finalOutput = outputForUser;
        break;
      }

      if (recovery.status === "repaired") {
        if (appConfig.evolution.policy_update_enabled) {
          const stat = await updateStrategyStats({
            pathValue: strategyStatsPath,
            skillId: recovery.skillId,
            scenarioTag: recovery.scenarioTag,
            success: true,
            latencyMs: recovery.elapsedMs
          });
          const existingIdx = strategyStatsDoc.records.findIndex(
            (item) => item.skill_id === stat.skill_id && item.scenario_tag === stat.scenario_tag
          );
          if (existingIdx >= 0) {
            strategyStatsDoc.records[existingIdx] = stat;
          } else {
            strategyStatsDoc.records.push(stat);
          }
          await emit({
            type: "strategy.updated",
            runId: ctx.runId,
            skillId: stat.skill_id,
            scenarioTag: stat.scenario_tag,
            attempts: stat.attempts,
            successes: stat.successes,
            ts: nowIso()
          });
        }
        nextMainTask = [
          request.task,
          `Recovery completed with ${recovery.skillId}.`,
          `Recovery summary: ${recovery.summary}`,
          "Continue and finish the original task."
        ].join("\n");
        continue;
      }

      status = "failed";
      failureKind = "tool";
      error = recovery.status === "need_user_gate"
        ? `Recovery blocked by user gate: ${recovery.reason}`
        : `Recovery unavailable: ${recovery.reason}`;
      finalOutput = outputForUser;
      break;
    }

    if (rawOutput.trim().length === 0 && runtimeErrors.length === 0 && summary === "none") {
      emptyResponseStreak += 1;
      if (emptyResponseStreak >= 2) {
        status = "failed";
        failureKind = "model";
        error = "Worker returned empty output in consecutive cycles";
        await emit({ type: "run.error", message: error, ts: nowIso() });
        break;
      }
      nextMainTask = [
        request.task,
        "Previous attempt produced empty output.",
        "Return a concise final answer text now. Do not stay silent."
      ].join("\n");
      continue;
    }
    emptyResponseStreak = 0;

    if (rawOutput.trim().length > 0 && !lastTurnContext.errorReason && runtimeErrors.length === 0) {
      finalOutput = outputForUser;
      status = "ok";
      break;
    }

    if (cycle === maxSelfIterCycles) {
      finalOutput = outputForUser;
      status = "failed";
      failureKind = "tool";
      error = `Main loop exited without final answer after ${maxSelfIterCycles} cycles`;
      await emit({ type: "iteration.exhausted", runId: ctx.runId, maxCycles: maxSelfIterCycles, ts: nowIso() });
      break;
    }

    nextMainTask = report.nextAction
      ? `${request.task}\n\nRetry focus:\n${report.nextAction}`
      : request.task;
  }

  if (status === "ok" && finalOutput && orchestrator) {
    try {
      const rewritten = await orchestrator.rewrite({
        task: request.task,
        style: executionSpec.style,
        workerOutput: finalOutput
      });
      if (rewritten?.final_reply?.trim()) {
        finalOutput = rewritten.final_reply.trim();
      }
    } catch (rewriteError) {
      await emit({
        type: "run.error",
        message: `rewrite failed: ${rewriteError instanceof Error ? rewriteError.message : String(rewriteError)}`,
        ts: nowIso()
      });
    }
  }

  if (status === "ok") {
    await setWorkflowPhase(ctx, "finished");
    await emit({
      type: "workflow.phase.changed",
      workflowId: workflow.workflowId,
      phase: "finished",
      ts: nowIso()
    });
  } else {
    await setWorkflowPhase(ctx, "failed");
    await emit({
      type: "workflow.phase.changed",
      workflowId: workflow.workflowId,
      phase: "failed",
      ts: nowIso()
    });
    if (error) {
      await emit({ type: "run.error", message: error, ts: nowIso() });
    }
  }

  const result: EngineRunResult = {
    status,
    outputText: finalOutput,
    usage,
    error,
    failureKind
  };

  try {
    const baseMemoryEntry = {
      ts: nowIso(),
      runId: ctx.runId,
      agentId: resolvedAgentId,
      task: request.task,
      status: result.status,
      outputSummary: summarizeResultForMemory(result)
    } as const;
    await appendTemporaryContext({
      paths: memoryPaths,
      entry: baseMemoryEntry,
      maxEntries: memoryOptions.temporaryMaxEntries
    });

    const temporaryCount = await countTemporaryContext(memoryPaths);
    if (temporaryCount >= memoryOptions.temporaryPromoteThreshold) {
      await emit({
        type: "memory.compaction.started",
        runId: ctx.runId,
        agentId: resolvedAgentId,
        trigger: "temporary_threshold",
        ts: nowIso()
      });

      const temporaryBatch = await readTemporaryContext(memoryPaths, memoryOptions.temporaryPromoteThreshold);
      let distillDecision = null;
      if (orchestrator) {
        try {
          distillDecision = await orchestrator.distill({
            agentId: resolvedAgentId,
            entries: temporaryBatch.map((entry) => ({
              ts: entry.ts,
              task: entry.task,
              status: entry.status,
              outputSummary: entry.outputSummary
            }))
          });
        } catch (distillError) {
          await emit({
            type: "run.error",
            message: `memory distill failed: ${distillError instanceof Error ? distillError.message : String(distillError)}`,
            ts: nowIso()
          });
        }
      }
      const fallbackPersonal = temporaryBatch
        .map((entry) => entry.outputSummary.trim())
        .filter(Boolean)
        .slice(-8);
      const fallbackGroup = fallbackPersonal.filter((text) =>
        /(must|always|should|never|prefer|fallback|policy|required|avoid)/i.test(text)
      );
      const personalMemories = distillDecision?.personal_memories?.filter(Boolean).slice(0, 12) ?? fallbackPersonal;
      const groupMemories = distillDecision?.group_memories?.filter(Boolean).slice(0, 12) ?? fallbackGroup.slice(0, 6);

      await appendPersonalVectorMemories({
        paths: memoryPaths,
        entries: personalMemories.map((text) => ({
          ts: nowIso(),
          runId: ctx.runId,
          agentId: resolvedAgentId,
          text
        })),
        options: memoryOptions
      });
      const promotedGroupCount = await appendGroupVectorMemories({
        paths: memoryPaths,
        entries: groupMemories.map((text) => ({
          ts: nowIso(),
          runId: ctx.runId,
          agentId: resolvedAgentId,
          text
        })),
        options: memoryOptions
      });
      await retainTemporaryContext(memoryPaths, memoryOptions.temporaryRetainAfterPromote);
      await compactVectorMemories({
        paths: memoryPaths,
        options: memoryOptions
      });

      if (promotedGroupCount > 0) {
        await emit({
          type: "memory.vector.group.appended",
          runId: ctx.runId,
          agentId: resolvedAgentId,
          count: promotedGroupCount,
          ts: nowIso()
        });
      }

      await emit({
        type: "memory.compaction.finished",
        runId: ctx.runId,
        agentId: resolvedAgentId,
        compacted: true,
        ts: nowIso()
      });
    }
  } catch (memoryError) {
    await emit({
      type: "run.error",
      message: `memory persistence failed: ${memoryError instanceof Error ? memoryError.message : String(memoryError)}`,
      ts: nowIso()
    });
  }

  await writeChain;
  await emit({ type: "run.finished", status: result.status, ts: nowIso() });
  await finalizeRun(ctx, result);

  return {
    runId: ctx.runId,
    result
  };
}
