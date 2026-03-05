import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { compileWorkerPrompt } from "../prompt-compiler/index.js";
import { fallbackSelectSkills } from "../skill-selector/index.js";
import { toRuntimePermission, minProfile } from "../security/permissions.js";
import { createOrchestrator } from "../orchestrator/index.js";
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
import { initWorkflowState, setThreadBinding, setWorkflowPhase } from "../workflow/session.js";
import { loadAgentSpec } from "../../registry/agent-spec.js";
import { loadAppConfig, loadPolicies, loadSkills } from "../../registry/index.js";
import { loadSkillIndex } from "../../registry/skill-index.js";
import { ensureRuntimeLibrary } from "../../runtime/library/index.js";
import { appendEvent, createRun, finalizeRun, writeSnapshot } from "../../storage/index.js";
import type {
  AgentSpec,
  EngineRunResult,
  PermissionProfile,
  Policy,
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

  const requireTopLlm = runMode === "managed";
  const topLlmBaseUrl = appConfig.top_llm?.base_url || process.env.OPENAI_BASE_URL;
  const summarizeTopLlmError = (message: string): string => {
    const statusMatch = message.match(/\b(4\d{2}|5\d{2})\b/);
    if (statusMatch) {
      const base = topLlmBaseUrl ? ` from ${topLlmBaseUrl}` : "";
      return `Top LLM request failed: HTTP ${statusMatch[1]}${base}`;
    }
    return `Top LLM request failed: ${message}`;
  };

  const failRunEarly = async (message: string): Promise<{ runId: string; result: EngineRunResult }> => {
    const error = message.trim();
    await emit({ type: "run.error", message: error, ts: nowIso() });
    const result: EngineRunResult = {
      status: "failed",
      outputText: "",
      error,
      failureKind: "tool"
    };
    await writeChain;
    await emit({ type: "run.finished", status: result.status, ts: nowIso() });
    await finalizeRun(ctx, result);
    return { runId: ctx.runId, result };
  };

  let orchestrator: ReturnType<typeof createOrchestrator> | null = null;
  try {
    orchestrator = createOrchestrator(appConfig);
  } catch (orchestratorError) {
    const message = `planner init failed: ${orchestratorError instanceof Error ? orchestratorError.message : String(orchestratorError)}`;
    await emit({ type: "run.error", message, ts: nowIso() });
    if (requireTopLlm) {
      return await failRunEarly(summarizeTopLlmError(message));
    }
  }

  let planDecision = null;
  let planErrorMessage: string | null = null;
  if (orchestrator) {
    try {
      planDecision = await orchestrator.plan({
        task: request.task,
        agent: executionSpec,
        skillLibrary: [...configSkills.values()],
        adminCap,
        currentProfile,
        localMemorySummary,
        globalMemorySummary
      });
    } catch (planError) {
      planErrorMessage = `planner failed: ${planError instanceof Error ? planError.message : String(planError)}`;
      await emit({ type: "run.error", message: planErrorMessage, ts: nowIso() });
    }
  }

  await writeSnapshot(ctx, "planner", planDecision);
  if (requireTopLlm && !planDecision) {
    const message = planErrorMessage ?? "planner returned invalid output";
    return await failRunEarly(summarizeTopLlmError(message));
  }

  const workflow = await initWorkflowState({
    ctx,
    request: { ...request, agentId: resolvedAgentId, taskWorkspace, controlPlaneRoot },
    timeoutMs: appConfig.workflow.timeout_ms
  });
  await writeSnapshot(ctx, "workflow", workflow);
  await emit({ type: "workflow.started", workflowId: workflow.workflowId, ts: nowIso() });

  const plannedInstruction = planDecision?.worker_instruction?.trim()
    ? planDecision.worker_instruction.trim()
    : request.task;
  const planSkillHints = Array.isArray(planDecision?.skill_hints) ? planDecision?.skill_hints ?? [] : [];
  const planRequiredProfile = planDecision?.required_profile ?? currentProfile;
  const directReply = planDecision?.direct_reply?.trim() || "";

  let nextMainTask = plannedInstruction;
  let finalOutput = directReply;
  let usage: EngineRunResult["usage"] | undefined;
  let status: EngineRunResult["status"] = "ok";
  let failureKind: EngineRunResult["failureKind"] | undefined;
  let error: string | undefined;
  const skipWorker = Boolean(directReply);
  const maxSelfIterCycles = Math.max(
    1,
    appConfig.workflow.max_self_iter_cycles ?? 1
  );
  let skipRewrite = false;
  let lastTurnContext: WorkerTurnContext | null = null;

  const buildCommonContext = (): string => orchestrator
    ? orchestrator.buildCommonContext({
      adminCap,
      currentProfile,
      localMemorySummary,
      globalMemorySummary
    })
    : "";

  if (!skipWorker) {
    const runtimePaths = await ensureRuntimeLibrary();
    const runtimeRoot = path.resolve(runtimePaths.root);
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

    if (!orchestrator) {
      return {
        decision: "escalate" as const,
        profile: permissionRequest.requested_profile,
        reason: "planner unavailable"
      };
    }

    let adminDecision = null;
    try {
      adminDecision = await orchestrator.approve({
        task: request.task,
        request: { type: "PERMISSION_REQUEST", ...permissionRequest },
        adminCap,
        commonContext: buildCommonContext()
      });
    } catch (approveError) {
      await emit({
        type: "run.error",
        message: `approval planner failed: ${approveError instanceof Error ? approveError.message : String(approveError)}`,
        ts: nowIso()
      });
    }
    if (!adminDecision) {
      return {
        decision: "deny" as const,
        profile: permissionRequest.requested_profile,
        reason: "admin decision output was invalid"
      };
    }
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

  const applyPermissionDecision = async (permissionRequest: { requested_profile: PermissionProfile; reason: string }, resumeTask?: string) => {
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
      if (resumeTask) {
        nextMainTask = [
          resumeTask,
          `Granted profile: ${adminDecision.profile}`,
          `Reason: ${adminDecision.reason}`
        ].join("\n");
        finalOutput = "";
      }
      return true;
    }

    if (adminDecision.decision === "deny") {
      status = "failed";
      failureKind = "tool";
      error = `Permission denied by admin: ${adminDecision.reason}`;
      finalOutput = "";
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
      finalOutput = "";
      return false;
    }

    rebuildMainWorker(adminDecision.profile);
    if (resumeTask) {
      nextMainTask = [
        resumeTask,
        `Granted profile: ${adminDecision.profile}`,
        `Reason: ${adminDecision.reason}`
      ].join("\n");
      finalOutput = "";
    }
    return true;
  };

  let proceed = true;
  if (isHigherProfile(planRequiredProfile, currentProfile)) {
    proceed = await applyPermissionDecision({
      requested_profile: planRequiredProfile,
      reason: "planner requested higher permission"
    });
  }

  if (proceed) {
    for (let cycle = 1; cycle <= maxSelfIterCycles; cycle += 1) {
      await emit({ type: "iteration.started", runId: ctx.runId, cycle, ts: nowIso() });

      const allSkills = mergedSkillLibrary();
      const candidateSkills = executionSpec.skillWhitelist.length > 0
        ? allSkills.filter((skill) => executionSpec.skillWhitelist.includes(skill.id))
        : allSkills;
      const maxSkills = 6;
      const hinted = filterAllowedSkillIds(planSkillHints, candidateSkills, maxSkills);
      const fallback = fallbackSelectSkills({
        task: nextMainTask,
        skillLibrary: candidateSkills,
        maxSkills
      });
      const selectedSkillIds = hinted.length > 0
        ? mergeSkillIds(hinted, [], maxSkills)
        : fallback.selectedSkillIds;
      const selectionMode = hinted.length > 0 ? "llm" : fallback.mode;
      const selectionReason = hinted.length > 0 ? "planner skill hints" : fallback.reason;

      await emit({
        type: "skills.selected",
        agentId: resolvedAgentId,
        selectedSkillIds,
        mode: selectionMode,
        reason: selectionReason,
        ts: nowIso()
      });

      const prompt = compileWorkerPrompt({
        task: nextMainTask,
        policy: currentPolicy,
        spec: executionSpec,
        skillLibrary: allSkills,
        selectedSkillIds,
        runtimePathsHint: [
          `runtime_root: ${runtimeRoot}`,
          `mcp_runtime_root: ${runtimePaths.mcpDir}`,
          "For MCP/tool virtualenvs and runtime artifacts, write under mcp_runtime_root instead of project-root .venv-* paths."
        ].join("\n"),
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
      const { summary, runtimeErrors } = summarizeCycleEvents(cycleEvents);
      cycleEvents = null;
      lastTurnContext = {
        cycle,
        maxCycles: maxSelfIterCycles,
        instruction: nextMainTask,
        workerOutput: rawOutput,
        userFacingOutput,
        errorReason: cycleError || report.errorReason || runtimeErrors[0],
        thinking: report.thinking,
        nextAction: report.nextAction,
        eventSummary: summary,
        runtimeErrors
      };

      await emit({ type: "iteration.worker.completed", runId: ctx.runId, cycle, ts: nowIso() });

      if (!orchestrator) {
        if (rawOutput) {
          finalOutput = userFacingOutput || rawOutput;
          status = "ok";
        } else {
          status = "failed";
          failureKind = "tool";
          error = cycleError || "worker failed without output";
        }
        break;
      }

      let iterateDecision;
      try {
        iterateDecision = await orchestrator.iterate({
          task: request.task,
          instruction: nextMainTask,
          cycle,
          maxCycles: maxSelfIterCycles,
          adminCap,
          currentProfile,
          workerOutput: rawOutput,
          userFacingOutput,
          errorReason: lastTurnContext.errorReason,
          thinking: lastTurnContext.thinking,
          nextAction: lastTurnContext.nextAction,
          eventSummary: lastTurnContext.eventSummary,
          runtimeErrors: lastTurnContext.runtimeErrors
        });
      } catch (iterateError) {
        status = "failed";
        failureKind = "tool";
        error = iterateError instanceof Error ? iterateError.message : String(iterateError);
        finalOutput = "";
        break;
      }

      if (!iterateDecision) {
        status = "failed";
        failureKind = "tool";
        error = "iterate decision output was invalid";
        finalOutput = "";
        break;
      }

      await emit({
        type: "iteration.decided",
        runId: ctx.runId,
        cycle,
        decision: iterateDecision.decision,
        reason: iterateDecision.reason,
        requestedProfile: iterateDecision.requested_profile,
        ts: nowIso()
      });

      if (iterateDecision.decision === "finish") {
        finalOutput = iterateDecision.final_reply || userFacingOutput || rawOutput;
        skipRewrite = Boolean(iterateDecision.final_reply);
        status = "ok";
        break;
      }

      if (iterateDecision.decision === "abort") {
        await emit({
          type: "iteration.aborted",
          runId: ctx.runId,
          cycle,
          reason: iterateDecision.reason,
          ts: nowIso()
        });
        finalOutput = iterateDecision.final_reply || userFacingOutput || rawOutput;
        skipRewrite = Boolean(iterateDecision.final_reply);
        status = "failed";
        failureKind = "tool";
        error = iterateDecision.reason;
        break;
      }

      if (iterateDecision.decision === "escalate") {
        const requestedProfile = iterateDecision.requested_profile || currentProfile;
        const ok = await applyPermissionDecision({
          requested_profile: requestedProfile,
          reason: iterateDecision.reason
        });
        if (!ok) {
          await emit({
            type: "iteration.aborted",
            runId: ctx.runId,
            cycle,
            reason: "permission escalation denied",
            ts: nowIso()
          });
          finalOutput = iterateDecision.final_reply || "";
          skipRewrite = Boolean(iterateDecision.final_reply);
          status = "failed";
          failureKind = "tool";
          error = "permission escalation denied";
          break;
        }
        nextMainTask = iterateDecision.next_instruction || nextMainTask;
        continue;
      }

      nextMainTask = iterateDecision.next_instruction || nextMainTask;
    }
  }

  }

  if (status === "ok" && !finalOutput) {
    if (orchestrator && lastTurnContext) {
      try {
        const exhaustedDecision = await orchestrator.iterate({
          task: request.task,
          instruction: lastTurnContext.instruction,
          cycle: maxSelfIterCycles,
          maxCycles: maxSelfIterCycles,
          adminCap,
          currentProfile,
          workerOutput: lastTurnContext.workerOutput,
          userFacingOutput: lastTurnContext.userFacingOutput,
          errorReason: `${lastTurnContext.errorReason || "iteration budget exhausted"}`,
          thinking: lastTurnContext.thinking,
          nextAction: lastTurnContext.nextAction,
          eventSummary: lastTurnContext.eventSummary,
          runtimeErrors: lastTurnContext.runtimeErrors
        });
        if (exhaustedDecision?.final_reply) {
          finalOutput = exhaustedDecision.final_reply;
          skipRewrite = true;
        }
      } catch (exhaustedError) {
        await emit({
          type: "run.error",
          message: `iterate exhausted failed: ${exhaustedError instanceof Error ? exhaustedError.message : String(exhaustedError)}`,
          ts: nowIso()
        });
      }
    }
    await emit({ type: "iteration.exhausted", runId: ctx.runId, maxCycles: maxSelfIterCycles, ts: nowIso() });
    status = "failed";
    failureKind = "tool";
    error = `Main loop exited without final answer after ${maxSelfIterCycles} cycles`;
  }

  if (status === "ok" && finalOutput && orchestrator && !skipWorker && !skipRewrite) {
    try {
      const rewritten = await orchestrator.rewrite({
        task: request.task,
        style: executionSpec.style,
        workerOutput: finalOutput
      });
      if (rewritten?.final_reply?.trim()) {
        finalOutput = rewritten.final_reply.trim();
      } else if (requireTopLlm) {
        status = "failed";
        failureKind = "tool";
        error = "Top LLM rewrite failed: invalid output";
      }
    } catch (rewriteError) {
      const message = `rewrite failed: ${rewriteError instanceof Error ? rewriteError.message : String(rewriteError)}`;
      await emit({ type: "run.error", message, ts: nowIso() });
      if (requireTopLlm) {
        status = "failed";
        failureKind = "tool";
        error = summarizeTopLlmError(message);
      }
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
