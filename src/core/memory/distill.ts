import type { Thread } from "@openai/codex-sdk";
import type { EngineRunResult, RunEvent } from "../../types/contracts.js";
import type { CodexSdkRuntimeClient, RunThreadArgs } from "../../runtime/codex-sdk/client.js";

const MEMORY_DISTILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    local_summary: { type: "string" },
    global_memories: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["local_summary", "global_memories"]
} as const;

const TEMPORARY_PROMOTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    personal_memories: {
      type: "array",
      items: { type: "string" }
    },
    group_memories: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["personal_memories", "group_memories"]
} as const;

export type DistilledMemory = {
  localSummary: string;
  globalMemories: string[];
};

export type TemporaryPromotionDecision = {
  personalMemories: string[];
  groupMemories: string[];
};

function fallbackDistill(task: string, result: EngineRunResult): DistilledMemory {
  const output = result.outputText?.trim() || result.error || "no output";
  const localSummary = `Task: ${task}\nStatus: ${result.status}\nResult: ${output.slice(0, 500)}`;
  return {
    localSummary,
    globalMemories: []
  };
}

function parseDistilledMemory(text: string): DistilledMemory | null {
  try {
    const parsed = JSON.parse(text) as { local_summary?: unknown; global_memories?: unknown };
    const localSummary = typeof parsed.local_summary === "string" ? parsed.local_summary.trim() : "";
    const globalMemories = Array.isArray(parsed.global_memories)
      ? parsed.global_memories.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    if (!localSummary) {
      return null;
    }
    return {
      localSummary,
      globalMemories
    };
  } catch {
    return null;
  }
}

function parseTemporaryPromotion(text: string): TemporaryPromotionDecision | null {
  try {
    const parsed = JSON.parse(text) as {
      personal_memories?: unknown;
      group_memories?: unknown;
    };
    const personalMemories = Array.isArray(parsed.personal_memories)
      ? parsed.personal_memories.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    const groupMemories = Array.isArray(parsed.group_memories)
      ? parsed.group_memories.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    return {
      personalMemories,
      groupMemories
    };
  } catch {
    return null;
  }
}

export async function distillMemoryWithCurrentAgent(args: {
  sdkClient: CodexSdkRuntimeClient;
  thread: Thread;
  agentId: string;
  task: string;
  result: EngineRunResult;
  onEvent?: (event: RunEvent) => void;
  fileChangeGuard?: RunThreadArgs["fileChangeGuard"];
}): Promise<DistilledMemory> {
  const prompt = [
    "Summarize durable memory from the task execution.",
    "Return strict JSON only with keys: local_summary, global_memories.",
    "local_summary: concise summary useful for this same agent in future tasks.",
    "global_memories: 0-3 concise stable lessons reusable by other agents.",
    `agent_id: ${args.agentId}`,
    `task: ${args.task}`,
    `status: ${args.result.status}`,
    `output_or_error: ${(args.result.outputText || args.result.error || "").slice(0, 2000)}`
  ].join("\n");

  try {
    const turn = await args.sdkClient.runThread({
      thread: args.thread,
      input: prompt,
      emitDeltaEvents: false,
      outputSchema: MEMORY_DISTILL_SCHEMA,
      onEvent: args.onEvent,
      fileChangeGuard: args.fileChangeGuard
    });
    const parsed = parseDistilledMemory(turn.outputText);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Fall back to deterministic summarization.
  }

  return fallbackDistill(args.task, args.result);
}

export async function classifyTemporaryContextForVector(args: {
  sdkClient: CodexSdkRuntimeClient;
  thread: Thread;
  agentId: string;
  entries: Array<{ ts: string; task: string; status: string; outputSummary: string }>;
  onEvent?: (event: RunEvent) => void;
  fileChangeGuard?: RunThreadArgs["fileChangeGuard"];
}): Promise<TemporaryPromotionDecision> {
  const compactEntries = args.entries.slice(-30).map((entry) => ({
    ts: entry.ts,
    task: entry.task,
    status: entry.status,
    outputSummary: entry.outputSummary
  }));

  const prompt = [
    "Classify temporary memory entries into personal vector memory and group vector memory.",
    "Return strict JSON only with keys: personal_memories, group_memories.",
    "Use concise durable statements; remove transient details.",
    "personal_memories: useful for this same agent's future tasks.",
    "group_memories: reusable cross-agent lessons (tool/process patterns).",
    "Do not duplicate the same sentence in both arrays.",
    `agent_id: ${args.agentId}`,
    `entries: ${JSON.stringify(compactEntries)}`
  ].join("\n");

  try {
    const turn = await args.sdkClient.runThread({
      thread: args.thread,
      input: prompt,
      emitDeltaEvents: false,
      outputSchema: TEMPORARY_PROMOTION_SCHEMA,
      onEvent: args.onEvent,
      fileChangeGuard: args.fileChangeGuard
    });
    const parsed = parseTemporaryPromotion(turn.outputText);
    if (parsed) {
      return {
        personalMemories: parsed.personalMemories.slice(0, 12),
        groupMemories: parsed.groupMemories.slice(0, 12)
      };
    }
  } catch {
    // fall through
  }

  const fallbackPersonal = compactEntries
    .map((entry) => entry.outputSummary.trim())
    .filter(Boolean)
    .slice(-8);
  const fallbackGroup = fallbackPersonal.filter((text) =>
    /(must|always|should|never|prefer|fallback|policy|必须|优先|不要|默认)/i.test(text)
  );
  return {
    personalMemories: fallbackPersonal,
    groupMemories: fallbackGroup.slice(0, 6)
  };
}
