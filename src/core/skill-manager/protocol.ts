import { z } from "zod";
import type {
  CapabilityFailed,
  CapabilityFeedback,
  CapabilityProtocolMessage,
  CapabilityReady,
  CapabilityRequest
} from "../../types/contracts.js";

const capabilityRequestSchema = z.object({
  type: z.literal("CAPABILITY_REQUEST"),
  capability_id: z.string().min(1),
  goal: z.string().min(1),
  io_contract: z.string().min(1),
  acceptance_tests: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()).optional(),
  promote_to_config_skills: z.boolean().optional()
});

const capabilityReadySchema = z.object({
  type: z.literal("CAPABILITY_READY"),
  capability_id: z.string().min(1),
  entrypoint: z.string().min(1),
  skill_path: z.string().min(1),
  tests_passed: z.boolean(),
  report: z.string().optional(),
  evidence: z.object({
    test_command: z.string().min(1),
    test_result_summary: z.string().min(1),
    external_receipt: z.string().optional(),
    side_effect_kind: z.enum(["none", "external_message", "external_api", "other"]).optional()
  })
});

const capabilityFailedSchema = z.object({
  type: z.literal("CAPABILITY_FAILED"),
  capability_id: z.string().min(1),
  error: z.string().min(1),
  attempts: z.number().int().positive()
});

const capabilityFeedbackSchema = z.object({
  type: z.literal("CAPABILITY_FEEDBACK"),
  capability_id: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional()
});

const capabilityProtocolSchema = z.discriminatedUnion("type", [
  capabilityRequestSchema,
  capabilityReadySchema,
  capabilityFailedSchema,
  capabilityFeedbackSchema
]);

function candidateJsonTexts(text: string): string[] {
  const candidates = new Set<string>();
  const trimmed = text.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }

  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    candidates.add(fenced[1].trim());
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.add(text.slice(start, end + 1).trim());
  }

  return [...candidates];
}

export function parseCapabilityProtocolMessage(text: string): CapabilityProtocolMessage | null {
  for (const candidate of candidateJsonTexts(text)) {
    try {
      const raw = JSON.parse(candidate);
      const parsed = capabilityProtocolSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data as CapabilityProtocolMessage;
      }
    } catch {
      // Ignore malformed candidate and continue trying.
    }
  }
  return null;
}

export function parseCapabilityRequest(text: string): CapabilityRequest | null {
  const message = parseCapabilityProtocolMessage(text);
  return message?.type === "CAPABILITY_REQUEST" ? (message as CapabilityRequest) : null;
}

export function parseCapabilityReady(text: string): CapabilityReady | null {
  const message = parseCapabilityProtocolMessage(text);
  return message?.type === "CAPABILITY_READY" ? (message as CapabilityReady) : null;
}

export function parseCapabilityFailed(text: string): CapabilityFailed | null {
  const message = parseCapabilityProtocolMessage(text);
  return message?.type === "CAPABILITY_FAILED" ? (message as CapabilityFailed) : null;
}

export function serializeCapabilityFeedback(feedback: CapabilityFeedback): string {
  return JSON.stringify(feedback, null, 2);
}
