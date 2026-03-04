import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { compileAgentSpecPrompt } from "../prompt-compiler/index.js";
import { classifyTemporaryContextForVector } from "../memory/distill.js";
import { findRepairSkillIds, isInstallIntentTask } from "../repair/index.js";
import { selectSkillsForTask } from "../skill-selector/index.js";
import { resolveCapability } from "../skill-manager/index.js";
import { parseCapabilityRequest } from "../skill-manager/protocol.js";
import { decidePermissionByAdmin } from "../security/admin-approver.js";
import { toRuntimePermission, minProfile } from "../security/permissions.js";
import { parsePermissionRequest } from "../security/protocol.js";
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
import { readWorkflowState } from "../workflow/state-store.js";
import { loadAgentPack, type AgentPack } from "../../registry/agent-pack.js";
import { loadAgentSpec } from "../../registry/agent-spec.js";
import { loadAppConfig, loadPolicies, loadSkills } from "../../registry/index.js";
import { loadSkillIndex } from "../../registry/skill-index.js";
import { ensureRuntimeLibrary } from "../../runtime/library/index.js";
import { appendEvent, createRun, finalizeRun, writeSnapshot } from "../../storage/index.js";
import type { AgentSpec, EngineRunResult, PermissionProfile, Policy, RunEvent, RunMode, RunRequest, Skill } from "../../types/contracts.js";
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

function repairPackFromAgentSpec(spec: AgentSpec): AgentPack {
  return {
    id: `${spec.id}-repair`,
    persona: spec.persona,
    workflow: spec.workflow,
    style: spec.style,
    ioContract: "Return strict capability protocol JSON only.",
    skills: spec.capabilityPolicy,
    skillWhitelist: spec.skillWhitelist,
    path: spec.path
  };
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
  const configRoot = path.resolve(controlPlaneRoot, "config");
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
      `Agent spec not found for '${resolvedAgentId}'. Expected file: config/agents/${resolvedAgentId}/agent.md`
    );
  }

  let repairPack: AgentPack;
  try {
    repairPack = await loadAgentPack("main-worker");
  } catch {
    repairPack = repairPackFromAgentSpec(executionSpec);
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
  const emitStream = (event: RunEvent): void => {
    hooks?.onEvent?.(event);
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

  const workflow = await initWorkflowState({
    ctx,
    request: { ...request, agentId: resolvedAgentId, taskWorkspace, controlPlaneRoot },
    timeoutMs: appConfig.workflow.capability_timeout_ms
  });
  await writeSnapshot(ctx, "workflow", workflow);
  await emit({ type: "workflow.started", workflowId: workflow.workflowId, ts: nowIso() });

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
  const mainAdditionalDirectories = [configSkillsRoot, runtimeRoot].filter((dir, idx, all) => all.indexOf(dir) === idx && existsSync(dir));
  let mainSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    ...toRuntimePermission(currentProfile),
    skipGitRepoCheck: true,
    additionalDirectories: mainAdditionalDirectories
  });
  const adminSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    ...toRuntimePermission("safe"),
    skipGitRepoCheck: true
  });
  const selectorSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    ...toRuntimePermission("safe"),
    skipGitRepoCheck: true,
  });
  const memorySdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    ...toRuntimePermission("safe"),
    skipGitRepoCheck: true,
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
  const memoryThread = memorySdkClient.startThread();
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

  let nextMainTask = request.task;
  let finalOutput = "";
  let usage: EngineRunResult["usage"] | undefined;
  let status: EngineRunResult["status"] = "ok";
  let failureKind: EngineRunResult["failureKind"] | undefined;
  let error: string | undefined;

  const maxMainCycles = Math.max(2, appConfig.workflow.max_capability_attempts + 1);
  let forceRepairSelection = false;

  for (let cycle = 1; cycle <= maxMainCycles; cycle += 1) {
    const allSkills = mergedSkillLibrary();
    const installIntent = isInstallIntentTask(nextMainTask);
    const candidateSkillsBase = executionSpec.skillWhitelist.length > 0
      ? allSkills.filter((skill) => executionSpec.skillWhitelist.includes(skill.id))
      : allSkills;
    const candidateSkills = (forceRepairSelection || installIntent)
      ? (() => {
          const byId = new Map(candidateSkillsBase.map((skill) => [skill.id, skill]));
          for (const repairSkill of allSkills.filter((skill) => skill.meta.repair_role === "repair")) {
            if (!byId.has(repairSkill.id)) {
              byId.set(repairSkill.id, repairSkill);
            }
          }
          return [...byId.values()];
        })()
      : candidateSkillsBase;
    const repairSkillIds = findRepairSkillIds(candidateSkills);
    const selectedSkills = await selectSkillsForTask({
      task: nextMainTask,
      spec: executionSpec,
      skillLibrary: candidateSkills,
      sdkClient: selectorSdkClient,
      localMemorySummary,
      globalMemorySummary,
      onEvent: emitStream,
      installIntent,
      enforceSkillIds: forceRepairSelection ? repairSkillIds : []
    });

    await emit({
      type: "skills.selected",
      agentId: resolvedAgentId,
      selectedSkillIds: selectedSkills.selectedSkillIds,
      mode: selectedSkills.mode,
      reason: selectedSkills.reason,
      ts: nowIso()
    });

    const prompt = compileAgentSpecPrompt({
      task: nextMainTask,
      policy: currentPolicy,
      spec: executionSpec,
      skillLibrary: allSkills,
      selectedSkillIds: selectedSkills.selectedSkillIds,
      runtimePathsHint: [
        `runtime_root: ${runtimeRoot}`,
        `mcp_runtime_root: ${runtimePaths.mcpDir}`,
        "For MCP/tool virtualenvs and runtime artifacts, write under mcp_runtime_root instead of project-root .venv-* paths."
      ].join("\n"),
      localMemorySummary,
      globalMemorySummary
    });

    await emit({ type: "prompt.compiled", size: prompt.size, ts: nowIso() });

    let mainTurn;
    try {
      mainTurn = await mainSdkClient.runThread({
        thread: mainThread,
        input: prompt.fullText,
        onEvent: emitStream
      });
    } catch (runError) {
      status = "failed";
      failureKind = "tool";
      error = runError instanceof Error ? runError.message : String(runError);
      finalOutput = "";
      break;
    }

    if (!mainThreadBound && mainTurn.threadId) {
      await setThreadBinding({ ctx, role: "main", threadId: mainTurn.threadId });
      await emit({
        type: "thread.created",
        role: "main",
        threadId: mainTurn.threadId,
        ts: nowIso()
      });
      mainThreadBound = true;
    }

    usage = mainTurn.usage;
    finalOutput = mainTurn.outputText.trim();

    const permissionRequest = parsePermissionRequest(mainTurn.outputText);
    if (permissionRequest) {
      await emit({
        type: "permission.requested",
        runId: ctx.runId,
        requestedProfile: permissionRequest.requested_profile,
        reason: permissionRequest.reason,
        ts: nowIso()
      });

      const adminDecision = runMode === "managed"
        ? await decidePermissionByAdmin({
            sdkClient: adminSdkClient,
            task: request.task,
            request: permissionRequest,
            adminCap,
            steelStampPath: appConfig.security.admin_stamp_path,
            onEvent: emitStream
          })
        : {
            decision: "escalate" as const,
            profile: permissionRequest.requested_profile,
            reason: "direct mode bypasses admin and requires user approval"
          };

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
          "Permission granted. Continue the original task immediately.",
          `Original task: ${request.task}`,
          `Granted profile: ${adminDecision.profile}`,
          `Reason: ${adminDecision.reason}`
        ].join("\n");
        finalOutput = "";
        continue;
      }

      if (adminDecision.decision === "deny") {
        status = "failed";
        failureKind = "tool";
        error = `Permission denied by admin: ${adminDecision.reason}`;
        finalOutput = "";
        break;
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
        break;
      }

      rebuildMainWorker(adminDecision.profile);
      nextMainTask = [
        "Permission escalation approved by user. Continue the original task immediately.",
        `Original task: ${request.task}`,
        `Granted profile: ${adminDecision.profile}`
      ].join("\n");
      finalOutput = "";
      continue;
    }

    const capabilityRequest = parseCapabilityRequest(mainTurn.outputText);
    if (capabilityRequest) {
      forceRepairSelection = true;
      await setWorkflowPhase(ctx, "resolving-capability");
      await emit({
        type: "workflow.phase.changed",
        workflowId: workflow.workflowId,
        phase: "resolving-capability",
        ts: nowIso()
      });
      await emit({
        type: "capability.requested",
        workflowId: workflow.workflowId,
        capabilityId: capabilityRequest.capability_id,
        ts: nowIso()
      });
      await emit({
        type: "repair.triggered",
        workflowId: workflow.workflowId,
        capabilityId: capabilityRequest.capability_id,
        reason: installIntent ? "install-intent" : "failure-signal",
        ts: nowIso()
      });

      const currentWorkflow = (await readWorkflowState(ctx)) || workflow;
      const capabilityResult = await resolveCapability({
        ctx,
        workflow: currentWorkflow,
        request: capabilityRequest,
        appConfig,
        policy: currentPolicy,
        pack: repairPack,
        skillLibrary: candidateSkills,
        sdkClient: mainSdkClient,
        runtimePaths,
        controlPlaneRoot,
        recommendedSources,
        onEvent: emitStream
      });

      if (capabilityResult.status === "ready") {
        await setWorkflowPhase(ctx, "running-main");
        await emit({
          type: "workflow.phase.changed",
          workflowId: workflow.workflowId,
          phase: "running-main",
          ts: nowIso()
        });

        nextMainTask = [
          "Continue the original task using the new capability immediately.",
          `Original task: ${request.task}`,
          `Resolved capability: ${JSON.stringify({
            type: "CAPABILITY_READY",
            capability_id: capabilityResult.capability_id,
            entrypoint: capabilityResult.entrypoint,
            skill_path: capabilityResult.skill_path,
            tests_passed: capabilityResult.tests_passed,
            evidence: capabilityResult.evidence
          }, null, 2)}`
        ].join("\n\n");
        finalOutput = "";
        continue;
      }

      status = "failed";
      failureKind = "tool";
      error = capabilityResult.error || "Capability resolution failed";
      finalOutput = "";
      break;
    }

    forceRepairSelection = false;
    break;
  }

  if (status === "ok" && !finalOutput) {
    status = "failed";
    failureKind = "tool";
    error = `Main loop exited without final answer after ${maxMainCycles} cycles`;
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
      const promoted = await classifyTemporaryContextForVector({
        sdkClient: memorySdkClient,
        thread: memoryThread,
        agentId: resolvedAgentId,
        entries: temporaryBatch.map((entry) => ({
          ts: entry.ts,
          task: entry.task,
          status: entry.status,
          outputSummary: entry.outputSummary
        })),
        onEvent: emitStream
      });

      await appendPersonalVectorMemories({
        paths: memoryPaths,
        entries: promoted.personalMemories.map((text) => ({
          ts: nowIso(),
          runId: ctx.runId,
          agentId: resolvedAgentId,
          text
        })),
        options: memoryOptions
      });
      const promotedGroupCount = await appendGroupVectorMemories({
        paths: memoryPaths,
        entries: promoted.groupMemories.map((text) => ({
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
