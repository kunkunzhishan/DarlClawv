import path from "node:path";
import { cp, stat } from "node:fs/promises";
import type { RunContext } from "../../storage/index.js";
import { appendEvent } from "../../storage/index.js";
import type { RunEvent } from "../../types/contracts.js";
import { ensureDir, fileExists } from "../../utils/fs.js";
import {
  listPendingPromotions,
  removePendingPromotion,
  type PendingPromotion
} from "../workflow/state-store.js";

function nowIso(): string {
  return new Date().toISOString();
}

function targetSkillPath(capabilityId: string): string {
  return path.resolve("config", "skills", capabilityId);
}

export async function getPendingPromotions(ctx: RunContext): Promise<PendingPromotion[]> {
  return await listPendingPromotions(ctx);
}

export async function promoteCapability(args: { ctx: RunContext; capabilityId: string }): Promise<{ targetPath: string }> {
  const pending = await listPendingPromotions(args.ctx);
  const item = pending.find((entry) => entry.capabilityId === args.capabilityId);
  if (!item) {
    throw new Error(`Pending promotion not found for capability: ${args.capabilityId}`);
  }

  if (!(await fileExists(item.sourcePath))) {
    throw new Error(`Capability source path not found: ${item.sourcePath}`);
  }

  const sourceStat = await stat(item.sourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Capability source path is not a directory: ${item.sourcePath}`);
  }

  const targetPath = targetSkillPath(args.capabilityId);
  await ensureDir(path.dirname(targetPath));
  await cp(item.sourcePath, targetPath, { recursive: true, force: true });

  const event: RunEvent = {
    type: "capability.promoted",
    workflowId: item.workflowId,
    capabilityId: args.capabilityId,
    targetPath,
    ts: nowIso()
  };
  await appendEvent(args.ctx, event);
  await removePendingPromotion(args.ctx, args.capabilityId);

  return { targetPath };
}

export async function rejectCapabilityPromotion(args: { ctx: RunContext; capabilityId: string }): Promise<void> {
  await removePendingPromotion(args.ctx, args.capabilityId);
}
