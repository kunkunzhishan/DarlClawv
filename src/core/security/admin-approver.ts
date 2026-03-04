import path from "node:path";
import type { RunEvent, PermissionDecision, PermissionProfile, PermissionRequest } from "../../types/contracts.js";
import type { CodexSdkRuntimeClient } from "../../runtime/codex-sdk/client.js";
import { fileExists, readText } from "../../utils/fs.js";
import { parsePermissionDecision, PERMISSION_DECISION_SCHEMA } from "./protocol.js";

function nowIso(): string {
  return new Date().toISOString();
}

const DEFAULT_STEEL_STAMP_PATH = "src/config/security/admin-steel-stamp.md";
const steelStampCache = new Map<string, string>();

function renderSteelStamp(template: string, args: {
  task: string;
  request: PermissionRequest;
  adminCap: PermissionProfile;
}): string {
  return template
    .replaceAll("{{task}}", args.task)
    .replaceAll("{{worker_request}}", JSON.stringify(args.request))
    .replaceAll("{{admin_cap}}", args.adminCap);
}

async function loadSteelStamp(stampPath?: string): Promise<string> {
  const resolved = path.resolve(stampPath || DEFAULT_STEEL_STAMP_PATH);
  const cached = steelStampCache.get(resolved);
  if (cached) {
    return cached;
  }
  if (!(await fileExists(resolved))) {
    throw new Error(`admin steel stamp file not found: ${resolved}`);
  }
  const content = (await readText(resolved)).trim();
  if (!content) {
    throw new Error(`admin steel stamp file is empty: ${resolved}`);
  }
  steelStampCache.set(resolved, content);
  return content;
}

export async function decidePermissionByAdmin(args: {
  sdkClient: CodexSdkRuntimeClient;
  task: string;
  request: PermissionRequest;
  adminCap: PermissionProfile;
  steelStampPath?: string;
  onEvent?: (event: RunEvent) => void;
}): Promise<PermissionDecision> {
  try {
    const steelStamp = await loadSteelStamp(args.steelStampPath);
    const prompt = renderSteelStamp(steelStamp, {
      task: args.task,
      request: args.request,
      adminCap: args.adminCap
    });
    const thread = args.sdkClient.startThread();

    const turn = await args.sdkClient.runThread({
      thread,
      input: prompt,
      emitDeltaEvents: false,
      outputSchema: PERMISSION_DECISION_SCHEMA,
      onEvent: args.onEvent
    });

    const parsed = parsePermissionDecision(turn.outputText);
    if (!parsed) {
      return {
        decision: "deny",
        profile: args.request.requested_profile,
        reason: "admin decision output was invalid"
      };
    }
    return parsed;
  } catch (error) {
    args.onEvent?.({
      type: "run.error",
      message: `permission admin failed: ${error instanceof Error ? error.message : String(error)}`,
      ts: nowIso()
    });

    return {
      decision: "deny",
      profile: args.request.requested_profile,
      reason: "permission admin execution failed"
    };
  }
}
