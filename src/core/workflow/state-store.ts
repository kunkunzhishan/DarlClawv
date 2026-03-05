import path from "node:path";
import type { ThreadBinding, WorkflowState } from "../../types/contracts.js";
import type { RunContext } from "../../storage/index.js";
import { ensureDir, fileExists, readText, writeText } from "../../utils/fs.js";

function workflowDir(ctx: RunContext): string {
  return path.join(ctx.runDir, "workflow");
}

function statePath(ctx: RunContext): string {
  return path.join(workflowDir(ctx), "state.json");
}

function threadsPath(ctx: RunContext): string {
  return path.join(workflowDir(ctx), "threads.json");
}

export async function ensureWorkflowDir(ctx: RunContext): Promise<void> {
  await ensureDir(workflowDir(ctx));
}

export async function writeWorkflowState(ctx: RunContext, state: WorkflowState): Promise<void> {
  await ensureWorkflowDir(ctx);
  await writeText(statePath(ctx), JSON.stringify(state, null, 2));
}

export async function readWorkflowState(ctx: RunContext): Promise<WorkflowState | null> {
  if (!(await fileExists(statePath(ctx)))) {
    return null;
  }

  const raw = await readText(statePath(ctx));
  return JSON.parse(raw) as WorkflowState;
}

export async function writeThreadBindings(ctx: RunContext, bindings: Partial<ThreadBinding>): Promise<void> {
  await ensureWorkflowDir(ctx);
  await writeText(threadsPath(ctx), JSON.stringify(bindings, null, 2));
}

export async function readThreadBindings(ctx: RunContext): Promise<Partial<ThreadBinding>> {
  if (!(await fileExists(threadsPath(ctx)))) {
    return {};
  }
  const raw = await readText(threadsPath(ctx));
  return JSON.parse(raw) as Partial<ThreadBinding>;
}
