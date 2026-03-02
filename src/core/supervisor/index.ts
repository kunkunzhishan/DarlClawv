import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileAgentSpecPrompt } from "../prompt-compiler/index.js";
import { evaluatePolicy } from "../policy-engine/index.js";
import { shouldRunCompaction } from "../memory/compaction.js";
import { classifyTemporaryContextForVector, distillMemoryWithCurrentAgent } from "../memory/distill.js";
import { findRepairSkillIds, isInstallIntentTask } from "../repair/index.js";
import { selectSkillsForTask } from "../skill-selector/index.js";
import { resolveCapability } from "../skill-manager/index.js";
import { parseCapabilityRequest } from "../skill-manager/protocol.js";
import {
  appendGlobalMemory,
  appendGroupVectorMemories,
  appendLocalMemory,
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
import { ensureRuntimeLibrary, loadRuntimeSkills } from "../../runtime/library/index.js";
import { appendEvent, createRun, finalizeRun, writeSnapshot } from "../../storage/index.js";
import type { AgentSpec, EngineRunResult, RunEvent, RunRequest } from "../../types/contracts.js";
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
  const appConfig = await loadAppConfig();
  const [configSkills, policies, skillIndexDoc] = await Promise.all([
    loadSkills(),
    loadPolicies(),
    loadSkillIndex()
  ]);
  const recommendedSources = skillIndexDoc.data.recommended_sources || [];

  const resolvedAgentId = request.agentId || appConfig.agent.default_id || appConfig.default_agent || "default";

  let executionSpec: AgentSpec;
  try {
    executionSpec = await loadAgentSpec(resolvedAgentId, appConfig.agent.config_root);
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
  const policy = policies.get(policyId);
  if (!policy) {
    throw new Error(`Policy not found: ${policyId}`);
  }

  const taskWorkspace = path.resolve(request.taskWorkspace || process.cwd());
  const controlPlaneRoot = path.resolve(
    request.controlPlaneRoot || process.env.MYDARL_CONTROL_PLANE_ROOT || inferControlPlaneRoot()
  );
  const configSkillsRoot = path.resolve(controlPlaneRoot, "config", "skills");
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
    options: memoryOptions
  });
  const localMemorySummary = summarizeLayeredLocalMemory(layeredMemory);
  const globalMemorySummary = summarizeLayeredGroupMemory(layeredMemory);

  await Promise.all([
    writeSnapshot(ctx, "app", appConfig),
    writeSnapshot(ctx, "policy", policy),
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
      allowControlPlaneSkillWrites
    })
  ]);

  const decision = evaluatePolicy(request.task, policy);
  if (!decision.ok) {
    const errorText = `Policy denied request: ${decision.reasons.join("; ")}`;
    await emit({ type: "run.error", message: errorText, ts: nowIso() });
    const failed: EngineRunResult = {
      status: "failed",
      outputText: "",
      error: errorText,
      failureKind: "tool"
    };
    await emit({ type: "run.finished", status: "failed", ts: nowIso() });
    await finalizeRun(ctx, failed);
    return { runId: ctx.runId, result: failed };
  }

  if (decision.confirmations.length > 0 && !request.confirm) {
    const errorText = `Policy requires explicit confirmation for patterns: ${decision.confirmations.join(", ")}. Re-run with --confirm.`;
    await emit({ type: "run.error", message: errorText, ts: nowIso() });
    const failed: EngineRunResult = {
      status: "failed",
      outputText: "",
      error: errorText,
      failureKind: "tool"
    };
    await emit({ type: "run.finished", status: "failed", ts: nowIso() });
    await finalizeRun(ctx, failed);
    return { runId: ctx.runId, result: failed };
  }

  const workflow = await initWorkflowState({
    ctx,
    request: { ...request, agentId: resolvedAgentId, taskWorkspace, controlPlaneRoot },
    timeoutMs: appConfig.workflow.capability_timeout_ms
  });
  await writeSnapshot(ctx, "workflow", workflow);
  await emit({ type: "workflow.started", workflowId: workflow.workflowId, ts: nowIso() });

  const runtimePaths = await ensureRuntimeLibrary();
  const runtimeRoot = path.resolve(runtimePaths.root);
  let runtimeSkills = await loadRuntimeSkills(runtimePaths);
  const mergedSkillLibrary = (): typeof runtimeSkills => {
    const byId = new Map<string, (typeof runtimeSkills)[number]>();
    for (const skill of runtimeSkills) {
      byId.set(skill.id, skill);
    }
    for (const skill of configSkills.values()) {
      if (!byId.has(skill.id)) {
        byId.set(skill.id, skill);
      }
    }
    return [...byId.values()];
  };
  const mainAdditionalDirectories = [configSkillsRoot, runtimeRoot].filter((dir, idx, all) => all.indexOf(dir) === idx && existsSync(dir));

  const mainSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    networkAccessEnabled: policy.network.enabled,
    additionalDirectories: mainAdditionalDirectories
  });
  const selectorSdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    networkAccessEnabled: false
  });
  const memorySdkClient = new CodexSdkRuntimeClient(appConfig.engine, {
    workingDirectory: taskWorkspace,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    networkAccessEnabled: false
  });

  const mainThread = workflow.threadBindings.main
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
      forbiddenRoots: [controlPlaneRoot, taskWorkspace],
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
      policy,
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
        onEvent: emitStream,
        fileChangeGuard: {
          role: "main",
          allowedWriteRoots: workspaceInsideControlPlane
            ? [configSkillsRoot, runtimeRoot]
            : [taskWorkspace, configSkillsRoot, runtimeRoot],
          forbiddenWriteRoots: [controlPlaneRoot],
          forbiddenWriteRootExceptions: [configSkillsRoot, runtimeRoot],
          addOnlyWriteRoots: [configSkillsRoot]
        }
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
        policy,
        pack: repairPack,
        skillLibrary: candidateSkills,
        sdkClient: mainSdkClient,
        runtimePaths,
        controlPlaneRoot,
        recommendedSources,
        onEvent: emitStream
      });

      if (capabilityResult.status === "ready") {
        runtimeSkills = await loadRuntimeSkills(runtimePaths);
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

  const shouldCompact = shouldRunCompaction({
    appConfig,
    result
  });

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

  if (shouldCompact) {
    await emit({
      type: "memory.compaction.started",
      runId: ctx.runId,
      agentId: resolvedAgentId,
      trigger: appConfig.memory.compaction.trigger,
      ts: nowIso()
    });

    const distilled = await distillMemoryWithCurrentAgent({
      sdkClient: memorySdkClient,
      thread: memoryThread,
      agentId: resolvedAgentId,
      task: request.task,
      result,
      onEvent: emitStream,
      fileChangeGuard: {
        role: "memory_compaction",
        allowedWriteRoots: [],
        forbiddenWriteRoots: [controlPlaneRoot, taskWorkspace]
      }
    });

    const localSummary = distilled.localSummary || summarizeResultForMemory(result);
    await appendLocalMemory(memoryPaths, {
      ts: baseMemoryEntry.ts,
      runId: ctx.runId,
      agentId: resolvedAgentId,
      task: request.task,
      status: result.status,
      outputSummary: localSummary
    });

    const appended = await appendGlobalMemory(
      memoryPaths,
      distilled.globalMemories.slice(0, 3).map((memory) => ({
        ts: baseMemoryEntry.ts,
        sourceAgentId: resolvedAgentId,
        runId: ctx.runId,
        memory
      }))
    );

    await appendPersonalVectorMemories({
      paths: memoryPaths,
      entries: [{
        ts: baseMemoryEntry.ts,
        runId: ctx.runId,
        agentId: resolvedAgentId,
        text: localSummary
      }],
      options: memoryOptions
    });
    await appendGroupVectorMemories({
      paths: memoryPaths,
      entries: distilled.globalMemories.slice(0, 3).map((memory) => ({
        ts: baseMemoryEntry.ts,
        runId: ctx.runId,
        agentId: resolvedAgentId,
        text: memory
      })),
      options: memoryOptions
    });
    await compactVectorMemories({
      paths: memoryPaths,
      options: memoryOptions
    });

    if (appended > 0) {
      await emit({
        type: "memory.distill.global.appended",
        runId: ctx.runId,
        agentId: resolvedAgentId,
        count: appended,
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
  } else {
    await appendLocalMemory(memoryPaths, baseMemoryEntry);
  }

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
      onEvent: emitStream,
      fileChangeGuard: {
        role: "memory_temp_promote",
        allowedWriteRoots: [],
        forbiddenWriteRoots: [controlPlaneRoot, taskWorkspace]
      }
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
        type: "memory.distill.global.appended",
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

  await writeChain;
  await emit({ type: "run.finished", status: result.status, ts: nowIso() });
  await finalizeRun(ctx, result);

  return {
    runId: ctx.runId,
    result
  };
}
