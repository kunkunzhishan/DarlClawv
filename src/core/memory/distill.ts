import type { Thread } from "@openai/codex-sdk";
import type { RunEvent } from "../../types/contracts.js";
import type { CodexSdkRuntimeClient } from "../../runtime/codex-sdk/client.js";

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

export type TemporaryPromotionDecision = {
  personalMemories: string[];
  groupMemories: string[];
};

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

export async function classifyTemporaryContextForVector(args: {
  sdkClient: CodexSdkRuntimeClient;
  thread: Thread;
  agentId: string;
  entries: Array<{ ts: string; task: string; status: string; outputSummary: string }>;
  onEvent?: (event: RunEvent) => void;
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
      onEvent: args.onEvent
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
