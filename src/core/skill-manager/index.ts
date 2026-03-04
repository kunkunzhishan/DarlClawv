import path from "node:path";
import { cp, stat } from "node:fs/promises";
import { compileAgentPackPrompt } from "../prompt-compiler/index.js";
import { classifyRepairPriorityLayer, sortSkillsByTrustAndPopularity, validateSkillSourceRef } from "../repair/index.js";
import { incrementCapabilityAttempt, isWorkflowExpired } from "../workflow/session.js";
import type { AgentPack } from "../../registry/agent-pack.js";
import type { RunContext } from "../../storage/index.js";
import type {
  AppConfig,
  CapabilityFeedback,
  CapabilityRequest,
  CapabilityResult,
  Policy,
  RunEvent,
  RuntimeLibraryPaths,
  SkillRecommendedSource,
  Skill,
  WorkflowState
} from "../../types/contracts.js";
import {
  ensureRuntimeLibrary,
  findRuntimeCapability,
  upsertRuntimeCapability
} from "../../runtime/library/index.js";
import type { CodexSdkRuntimeClient } from "../../runtime/codex-sdk/client.js";
import { ensureDir, fileExists } from "../../utils/fs.js";
import { parseCapabilityFailed, parseCapabilityReady, serializeCapabilityFeedback } from "./protocol.js";
import { renderPromptTemplate } from "../../registry/prompt-templates.js";

function nowIso(): string {
  return new Date().toISOString();
}

function isPathInsideRoot(candidateAbs: string, rootAbs: string): boolean {
  const rel = path.relative(rootAbs, candidateAbs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolvePathInRoot(candidatePath: string, rootPath: string): string | null {
  const rootAbs = path.resolve(rootPath);
  const candidateAbs = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(rootAbs, candidatePath);
  return isPathInsideRoot(candidateAbs, rootAbs) ? candidateAbs : null;
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, "").trim()).filter(Boolean);
}

function isPathLikeToken(token: string): boolean {
  return token.includes("/") || token.startsWith(".") || /\.(py|sh|js|ts|mjs|cjs)$/i.test(token);
}

export async function resolveEntrypointPathInRoot(entrypoint: string, rootPath: string): Promise<string | null> {
  const tokens = tokenizeCommand(entrypoint);
  if (tokens.length === 0) {
    return null;
  }

  const candidates = tokens.filter((token, idx) => idx > 0 ? isPathLikeToken(token) : token.includes("/") || token.startsWith("."));
  for (const candidate of candidates) {
    const resolved = resolvePathInRoot(candidate, rootPath);
    if (resolved && (await fileExists(resolved))) {
      return resolved;
    }
  }

  return null;
}

async function resolveEntrypointPathInRoots(entrypoint: string, rootPaths: string[]): Promise<string | null> {
  for (const rootPath of rootPaths) {
    const resolved = await resolveEntrypointPathInRoot(entrypoint, rootPath);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

function resolveConfigSkillPath(args: { controlPlaneRoot?: string; capabilityId: string }): string {
  const controlPlaneRoot = path.resolve(args.controlPlaneRoot || process.cwd());
  return path.resolve(controlPlaneRoot, "config", "skills", args.capabilityId);
}

async function materializeSkillToConfig(args: {
  capabilityId: string;
  requestedSkillPath: string;
  runtimeRoot: string;
  controlPlaneRoot?: string;
}): Promise<{ ok: true; skillPath: string } | { ok: false; reason: string }> {
  const targetSkillPath = resolveConfigSkillPath({
    controlPlaneRoot: args.controlPlaneRoot,
    capabilityId: args.capabilityId
  });
  const configSkillsRoot = path.dirname(targetSkillPath);
  const requestedAbs = path.resolve(args.requestedSkillPath);
  const inConfigSkills = resolvePathInRoot(requestedAbs, configSkillsRoot);
  const inRuntimeRoot = resolvePathInRoot(requestedAbs, args.runtimeRoot);

  if (!inConfigSkills && !inRuntimeRoot) {
    return {
      ok: false,
      reason: `skill_path must be under config/skills or runtime staging root: ${args.requestedSkillPath}`
    };
  }

  const sourceSkillPath = inConfigSkills || inRuntimeRoot;
  if (!sourceSkillPath || !(await fileExists(sourceSkillPath)) || !(await isDirectory(sourceSkillPath))) {
    return {
      ok: false,
      reason: `skill_path does not exist or is not a directory: ${sourceSkillPath || args.requestedSkillPath}`
    };
  }

  if (path.resolve(sourceSkillPath) !== path.resolve(targetSkillPath)) {
    await ensureDir(path.dirname(targetSkillPath));
    await cp(sourceSkillPath, targetSkillPath, { recursive: true, force: true });
  }

  const skillDocPath = path.join(targetSkillPath, "SKILL.md");
  if (!(await fileExists(skillDocPath))) {
    return {
      ok: false,
      reason: `config skill is missing SKILL.md after install: ${targetSkillPath}`
    };
  }

  return { ok: true, skillPath: targetSkillPath };
}

function requiresExternalReceipt(request: CapabilityRequest): boolean {
  const text = `${request.goal}\n${request.io_contract}\n${request.acceptance_tests.join("\n")}`.toLowerCase();
  return /(wechat|message|sms|email|notification|webhook|payment|transfer|send)/.test(text);
}

function buildSkillManagerTask(args: {
  request: CapabilityRequest;
  attempt: number;
  runtimeRoot: string;
  configSkillsRoot: string;
  codexHome?: string;
  recommendedSources: SkillRecommendedSource[];
  feedback?: CapabilityFeedback;
}): string {
  const feedbackSection = args.feedback
    ? renderPromptTemplate("skill-manager/feedback-section", {
        feedback_json: serializeCapabilityFeedback(args.feedback)
      })
    : "";

  return renderPromptTemplate("skill-manager/task", {
    attempt: String(args.attempt),
    runtime_root: args.runtimeRoot,
    config_skills_root: args.configSkillsRoot,
    codex_home: args.codexHome || "unset",
    recommended_sources_json: JSON.stringify(args.recommendedSources, null, 2),
    request_json: JSON.stringify(args.request, null, 2),
    feedback_section: feedbackSection
  });
}

export async function resolveCapability(args: {
  ctx: RunContext;
  workflow: WorkflowState;
  request: CapabilityRequest;
  appConfig: AppConfig;
  policy: Policy;
  pack: AgentPack;
  skillLibrary: Skill[];
  sdkClient: CodexSdkRuntimeClient;
  runtimePaths?: RuntimeLibraryPaths;
  controlPlaneRoot?: string;
  recommendedSources?: SkillRecommendedSource[];
  onEvent?: (event: RunEvent) => void;
}): Promise<CapabilityResult> {
  const runtimePaths = args.runtimePaths ?? (await ensureRuntimeLibrary());
  const controlPlaneRoot = path.resolve(args.controlPlaneRoot || process.cwd());
  const configSkillPath = resolveConfigSkillPath({
    controlPlaneRoot,
    capabilityId: args.request.capability_id
  });

  if (await fileExists(path.join(configSkillPath, "SKILL.md"))) {
    await upsertRuntimeCapability(runtimePaths, {
      id: args.request.capability_id,
      path: configSkillPath,
      kind: "skill",
      status: "active",
      lastUsedAt: nowIso()
    });
    args.onEvent?.({
      type: "repair.completed",
      workflowId: args.workflow.workflowId,
      capabilityId: args.request.capability_id,
      status: "ready",
      attempts: args.workflow.attemptsByCapability[args.request.capability_id] ?? 0,
      ts: nowIso()
    });
    return {
      status: "ready",
      capability_id: args.request.capability_id,
      entrypoint: `use:${args.request.capability_id}`,
      skill_path: configSkillPath,
      tests_passed: true,
      attempts: args.workflow.attemptsByCapability[args.request.capability_id] ?? 0,
      report: "Capability already active in config skills"
    };
  }

  const existing = await findRuntimeCapability(runtimePaths, args.request.capability_id);
  if (existing && existing.status === "active") {
    const materialized = await materializeSkillToConfig({
      capabilityId: args.request.capability_id,
      requestedSkillPath: existing.path,
      runtimeRoot: runtimePaths.root,
      controlPlaneRoot
    });
    if (!materialized.ok) {
      return {
        status: "failed",
        capability_id: args.request.capability_id,
        attempts: args.workflow.attemptsByCapability[args.request.capability_id] ?? 0,
        error: materialized.reason
      };
    }
    await upsertRuntimeCapability(runtimePaths, {
      id: args.request.capability_id,
      path: materialized.skillPath,
      kind: "skill",
      status: "active",
      lastUsedAt: nowIso()
    });
    args.onEvent?.({
      type: "repair.completed",
      workflowId: args.workflow.workflowId,
      capabilityId: args.request.capability_id,
      status: "ready",
      attempts: args.workflow.attemptsByCapability[args.request.capability_id] ?? 0,
      ts: nowIso()
    });
    return {
      status: "ready",
      capability_id: args.request.capability_id,
      entrypoint: `use:${args.request.capability_id}`,
      skill_path: materialized.skillPath,
      tests_passed: true,
      attempts: args.workflow.attemptsByCapability[args.request.capability_id] ?? 0,
      report: "Capability already active"
    };
  }

  args.onEvent?.({
    type: "capability.resolve.started",
    workflowId: args.workflow.workflowId,
    capabilityId: args.request.capability_id,
    ts: nowIso()
  });

  const repairSkills = args.skillLibrary.filter((skill) => skill.meta.repair_role === "repair");
  const priority = classifyRepairPriorityLayer(repairSkills);
  const prioritizedSkillLibrary = sortSkillsByTrustAndPopularity(args.skillLibrary);
  args.onEvent?.({
    type: "repair.priority.selected",
    workflowId: args.workflow.workflowId,
    capabilityId: args.request.capability_id,
    layer: priority.layer,
    selectedSkillIds: priority.selectedSkillIds,
    ts: nowIso()
  });

  let feedback: CapabilityFeedback | undefined;

  for (let attempt = 1; attempt <= args.appConfig.workflow.max_capability_attempts; attempt += 1) {
    const currentState = await incrementCapabilityAttempt({
      ctx: args.ctx,
      capabilityId: args.request.capability_id
    });

    if (isWorkflowExpired(currentState)) {
      args.onEvent?.({
        type: "repair.completed",
        workflowId: currentState.workflowId,
        capabilityId: args.request.capability_id,
        status: "failed",
        attempts: attempt,
        ts: nowIso()
      });
      return {
        status: "failed",
        capability_id: args.request.capability_id,
        attempts: attempt,
        error: "Capability resolution timed out"
      };
    }

    args.onEvent?.({
      type: "capability.resolve.attempt",
      workflowId: currentState.workflowId,
      capabilityId: args.request.capability_id,
      attempt,
      ts: nowIso()
    });

    const prompt = compileAgentPackPrompt({
      task: buildSkillManagerTask({
        request: args.request,
        attempt,
        runtimeRoot: runtimePaths.root,
        configSkillsRoot: path.resolve(controlPlaneRoot, "config", "skills"),
        codexHome: args.appConfig.engine.codex_home
          ? path.resolve(args.appConfig.engine.codex_home)
          : (process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : undefined),
        recommendedSources: args.recommendedSources || [],
        feedback
      }),
      policy: args.policy,
      pack: args.pack,
      skillLibrary: prioritizedSkillLibrary
    });

    const capabilityThread = args.sdkClient.startThread();
    let turn;
    try {
      turn = await args.sdkClient.runThread({
        thread: capabilityThread,
        input: prompt.fullText,
        emitDeltaEvents: false,
        onEvent: args.onEvent
      });
    } catch (runError) {
      const failureReason = runError instanceof Error ? runError.message : String(runError);
      feedback = {
        type: "CAPABILITY_FEEDBACK",
        capability_id: args.request.capability_id,
        ok: false,
        error: failureReason
      };
      if (attempt >= args.appConfig.workflow.max_capability_attempts) {
        args.onEvent?.({
          type: "capability.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          attempts: attempt,
          reason: failureReason,
          ts: nowIso()
        });
        args.onEvent?.({
          type: "repair.completed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          status: "failed",
          attempts: attempt,
          ts: nowIso()
        });
        return {
          status: "failed",
          capability_id: args.request.capability_id,
          attempts: attempt,
          error: failureReason
        };
      }
      continue;
    }

    const ready = parseCapabilityReady(turn.outputText);
    if (ready && ready.tests_passed) {
      if (ready.capability_id !== args.request.capability_id) {
        feedback = {
          type: "CAPABILITY_FEEDBACK",
          capability_id: args.request.capability_id,
          ok: false,
          error: `Capability id mismatch: requested=${args.request.capability_id}, got=${ready.capability_id}`
        };
        continue;
      }

      const materialized = await materializeSkillToConfig({
        capabilityId: ready.capability_id,
        requestedSkillPath: ready.skill_path,
        runtimeRoot: runtimePaths.root,
        controlPlaneRoot
      });
      if (!materialized.ok) {
        feedback = {
          type: "CAPABILITY_FEEDBACK",
          capability_id: args.request.capability_id,
          ok: false,
          error: materialized.reason
        };
        args.onEvent?.({
          type: "capability.validation.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          reason: materialized.reason,
          ts: nowIso()
        });
        continue;
      }
      const configSkillsRoot = path.resolve(controlPlaneRoot, "config", "skills");
      const resolvedEntrypointPath = await resolveEntrypointPathInRoots(ready.entrypoint, [
        materialized.skillPath,
        controlPlaneRoot,
        configSkillsRoot,
        runtimePaths.root
      ]);
      if (!resolvedEntrypointPath) {
        const reason = `entrypoint does not reference an existing executable/script under config or runtime roots: ${ready.entrypoint}`;
        feedback = {
          type: "CAPABILITY_FEEDBACK",
          capability_id: args.request.capability_id,
          ok: false,
          error: reason
        };
        args.onEvent?.({
          type: "capability.validation.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          reason,
          ts: nowIso()
        });
        continue;
      }

      const evidence = ready.evidence;
      if (!evidence?.test_command || !evidence?.test_result_summary) {
        const reason = "missing required evidence.test_command or evidence.test_result_summary";
        feedback = {
          type: "CAPABILITY_FEEDBACK",
          capability_id: args.request.capability_id,
          ok: false,
          error: reason
        };
        args.onEvent?.({
          type: "capability.validation.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          reason,
          ts: nowIso()
        });
        args.onEvent?.({
          type: "repair.validation.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          reason,
          ts: nowIso()
        });
        continue;
      }

      if (requiresExternalReceipt(args.request) && !evidence.external_receipt) {
        const reason = "external side-effect capability requires evidence.external_receipt";
        feedback = {
          type: "CAPABILITY_FEEDBACK",
          capability_id: args.request.capability_id,
          ok: false,
          error: reason
        };
        args.onEvent?.({
          type: "capability.validation.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          reason,
          ts: nowIso()
        });
        args.onEvent?.({
          type: "repair.validation.failed",
          workflowId: currentState.workflowId,
          capabilityId: args.request.capability_id,
          reason,
          ts: nowIso()
        });
        continue;
      }

      const matchingSkill = args.skillLibrary.find((skill) => skill.id === ready.capability_id);
      if (matchingSkill?.meta.source_ref) {
        const sourceCheck = validateSkillSourceRef({
          sourceRef: matchingSkill.meta.source_ref,
          recommendedSources: args.recommendedSources || []
        });
        if (!sourceCheck.trusted) {
          const reason = sourceCheck.reason || "untrusted source_ref";
          feedback = {
            type: "CAPABILITY_FEEDBACK",
            capability_id: args.request.capability_id,
            ok: false,
            error: reason
          };
          args.onEvent?.({
            type: "repair.source.rejected",
            workflowId: currentState.workflowId,
            capabilityId: args.request.capability_id,
            sourceRef: matchingSkill.meta.source_ref,
            reason,
            ts: nowIso()
          });
          continue;
        }
      }

      await upsertRuntimeCapability(runtimePaths, {
        id: ready.capability_id,
        path: materialized.skillPath,
        kind: "skill",
        status: "active",
        lastUsedAt: nowIso()
      });

      args.onEvent?.({
        type: "capability.ready",
        workflowId: currentState.workflowId,
        capabilityId: ready.capability_id,
        entrypoint: ready.entrypoint,
        skillPath: materialized.skillPath,
        evidence: ready.evidence,
        ts: nowIso()
      });

      args.onEvent?.({
        type: "repair.completed",
        workflowId: currentState.workflowId,
        capabilityId: args.request.capability_id,
        status: "ready",
        attempts: attempt,
        ts: nowIso()
      });

      return {
        status: "ready",
        capability_id: ready.capability_id,
        entrypoint: ready.entrypoint,
        skill_path: materialized.skillPath,
        tests_passed: ready.tests_passed,
        evidence: ready.evidence,
        attempts: attempt,
        report: ready.report
      };
    }

    const failed = parseCapabilityFailed(turn.outputText);
    const failureReason =
      failed?.error || `Invalid capability response from repair resolver: ${turn.outputText.slice(0, 500)}`;

    feedback = {
      type: "CAPABILITY_FEEDBACK",
      capability_id: args.request.capability_id,
      ok: false,
      error: failureReason
    };

    if (attempt >= args.appConfig.workflow.max_capability_attempts) {
      args.onEvent?.({
        type: "capability.failed",
        workflowId: currentState.workflowId,
        capabilityId: args.request.capability_id,
        attempts: attempt,
        reason: failureReason,
        ts: nowIso()
      });
      args.onEvent?.({
        type: "repair.completed",
        workflowId: currentState.workflowId,
        capabilityId: args.request.capability_id,
        status: "failed",
        attempts: attempt,
        ts: nowIso()
      });

      return {
        status: "failed",
        capability_id: args.request.capability_id,
        attempts: attempt,
        error: failureReason
      };
    }
  }

  args.onEvent?.({
    type: "repair.completed",
    workflowId: args.workflow.workflowId,
    capabilityId: args.request.capability_id,
    status: "failed",
    attempts: args.appConfig.workflow.max_capability_attempts,
    ts: nowIso()
  });

  return {
    status: "failed",
    capability_id: args.request.capability_id,
    attempts: args.appConfig.workflow.max_capability_attempts,
    error: "Capability resolution exhausted retries"
  };
}
