import type { RunContext } from "../../storage/index.js";
import type { RunRequest, WorkflowPhase, WorkflowState } from "../../types/contracts.js";
import {
  readThreadBindings,
  readWorkflowState,
  writeThreadBindings,
  writeWorkflowState
} from "./state-store.js";

function nowIso(): string {
  return new Date().toISOString();
}

function nextWorkflowId(runId: string): string {
  return `${runId}-wf`;
}

function addMs(iso: string, durationMs: number): string {
  return new Date(new Date(iso).getTime() + durationMs).toISOString();
}

export async function initWorkflowState(args: {
  ctx: RunContext;
  request: RunRequest;
  timeoutMs: number;
}): Promise<WorkflowState> {
  const existing = await readWorkflowState(args.ctx);
  if (existing) {
    return existing;
  }

  const startedAt = nowIso();
  const state: WorkflowState = {
    workflowId: args.request.workflowId || nextWorkflowId(args.ctx.runId),
    runId: args.ctx.runId,
    phase: "started",
    threadBindings: await readThreadBindings(args.ctx),
    attemptsByCapability: {},
    startedAt,
    updatedAt: startedAt,
    deadlineAt: addMs(startedAt, args.timeoutMs)
  };

  await writeWorkflowState(args.ctx, state);
  return state;
}

export async function setWorkflowPhase(ctx: RunContext, phase: WorkflowPhase): Promise<WorkflowState> {
  const current = await readWorkflowState(ctx);
  if (!current) {
    throw new Error("Workflow state not initialized");
  }

  const next: WorkflowState = {
    ...current,
    phase,
    updatedAt: nowIso()
  };

  await writeWorkflowState(ctx, next);
  return next;
}

export async function setThreadBinding(args: {
  ctx: RunContext;
  role: "main";
  threadId: string;
}): Promise<WorkflowState> {
  const current = await readWorkflowState(args.ctx);
  if (!current) {
    throw new Error("Workflow state not initialized");
  }

  const next: WorkflowState = {
    ...current,
    threadBindings: {
      ...current.threadBindings,
      [args.role]: args.threadId
    },
    updatedAt: nowIso()
  };

  await writeThreadBindings(args.ctx, next.threadBindings);
  await writeWorkflowState(args.ctx, next);
  return next;
}

export async function incrementCapabilityAttempt(args: {
  ctx: RunContext;
  capabilityId: string;
}): Promise<WorkflowState> {
  const current = await readWorkflowState(args.ctx);
  if (!current) {
    throw new Error("Workflow state not initialized");
  }

  const next: WorkflowState = {
    ...current,
    attemptsByCapability: {
      ...current.attemptsByCapability,
      [args.capabilityId]: (current.attemptsByCapability[args.capabilityId] || 0) + 1
    },
    updatedAt: nowIso()
  };

  await writeWorkflowState(args.ctx, next);
  return next;
}

export function isWorkflowExpired(state: WorkflowState): boolean {
  return new Date().getTime() > new Date(state.deadlineAt).getTime();
}
