import { z } from "zod";
import type { PermissionDecision, PermissionRequest } from "../../types/contracts.js";

const permissionProfileSchema = z.enum(["safe", "workspace", "full"]);

const permissionRequestSchema = z.object({
  type: z.literal("PERMISSION_REQUEST"),
  requested_profile: permissionProfileSchema,
  reason: z.string().min(1)
});

const permissionDecisionSchema = z.object({
  decision: z.enum(["grant", "deny", "escalate"]),
  profile: permissionProfileSchema,
  reason: z.string().min(1)
});

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

export function parsePermissionRequest(text: string): PermissionRequest | null {
  for (const candidate of candidateJsonTexts(text)) {
    try {
      const raw = JSON.parse(candidate);
      const parsed = permissionRequestSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Ignore malformed candidate and continue trying.
    }
  }
  return null;
}

export function parsePermissionDecision(text: string): PermissionDecision | null {
  for (const candidate of candidateJsonTexts(text)) {
    try {
      const raw = JSON.parse(candidate);
      const parsed = permissionDecisionSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Ignore malformed candidate and continue trying.
    }
  }
  return null;
}

export const PERMISSION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["grant", "deny", "escalate"] },
    profile: { type: "string", enum: ["safe", "workspace", "full"] },
    reason: { type: "string" }
  },
  required: ["decision", "profile", "reason"]
} as const;
