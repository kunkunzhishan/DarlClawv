import OpenAI from "openai";
import { z } from "zod";
import { renderPromptTemplate } from "../../registry/prompt-templates.js";
import type {
  AgentSpec,
  AppConfig,
  PermissionProfile,
  PermissionRequest,
  Skill,
  TopLlmApprovalDecision,
  TopLlmDistillDecision,
  TopLlmIterateDecision,
  TopLlmPlanDecision,
  TopLlmRewriteDecision
} from "../../types/contracts.js";

const optionalNonEmpty = z.preprocess((value) => {
  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, z.string().trim().min(1).optional()) as z.ZodType<string | undefined>;

const planSchema = z.object({
  worker_instruction: optionalNonEmpty,
  direct_reply: optionalNonEmpty,
  skill_hints: z.array(z.string()).default([]),
  required_profile: z.enum(["safe", "workspace", "full"]).default("safe")
}).refine((value) => Boolean(value.worker_instruction || value.direct_reply), {
  message: "worker_instruction or direct_reply is required"
});

const approvalSchema = z.object({
  decision: z.enum(["grant", "deny", "escalate"]),
  profile: z.enum(["safe", "workspace", "full"]),
  reason: z.string().min(1)
});

const iterateSchema = z.object({
  decision: z.enum(["retry", "escalate", "finish", "abort"]),
  reason: z.string().min(1),
  next_instruction: optionalNonEmpty,
  requested_profile: z.enum(["safe", "workspace", "full"]).optional(),
  final_reply: optionalNonEmpty
});

const rewriteSchema = z.object({
  final_reply: z.string().min(1)
});

const distillSchema = z.object({
  personal_memories: z.array(z.string()).default([]),
  group_memories: z.array(z.string()).default([])
});

function extractJsonCandidates(text: string): string[] {
  const out = new Set<string>();
  const trimmed = text.trim();
  if (trimmed) {
    out.add(trimmed);
  }
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    out.add(fenced[1].trim());
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    out.add(text.slice(start, end + 1).trim());
  }
  return [...out];
}

function parseJsonWithSchema<T>(text: string, schema: z.ZodSchema<T>): T | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    } catch {
      // ignore malformed candidate
    }
  }
  return null;
}

function extractOutputText(response: unknown): string {
  const payload = response as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof payload?.output_text === "string") {
    return payload.output_text;
  }
  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (content?.type === "output_text" || content?.type === "text") {
            if (typeof content.text === "string") {
              return content.text;
            }
          }
        }
      }
    }
  }
  return "";
}

function truncateForError(text: string, max = 600): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...`;
}

function renderSkillCatalog(skills: Skill[]): string {
  if (skills.length === 0) {
    return "(no skills available)";
  }
  return skills
    .map((skill) => {
      const aliases = skill.meta.selector?.aliases?.join(", ") || "none";
      const tags = skill.meta.selector?.tags?.join(", ") || "none";
      const keywords = skill.meta.trigger.keywords?.join(", ") || "none";
      const summary = skill.meta.summary || "none";
      const entrypoint = skill.package?.entrypoint || "none";
      return [
        `id: ${skill.id}`,
        `description: ${skill.meta.description}`,
        `summary: ${summary}`,
        `aliases: ${aliases}`,
        `tags: ${tags}`,
        `keywords: ${keywords}`,
        `entrypoint: ${entrypoint}`
      ].join("\n");
    })
    .join("\n\n");
}

function buildCommonContext(args: {
  adminCap: PermissionProfile;
  currentProfile: PermissionProfile;
  localMemorySummary?: string;
  globalMemorySummary?: string;
}): string {
  const parts: string[] = [];
  parts.push(`admin_cap: ${args.adminCap}`);
  parts.push(`current_profile: ${args.currentProfile}`);
  if (args.localMemorySummary) {
    parts.push("[LOCAL_MEMORY]");
    parts.push(args.localMemorySummary.trim());
  }
  if (args.globalMemorySummary) {
    parts.push("[GLOBAL_MEMORY]");
    parts.push(args.globalMemorySummary.trim());
  }
  return parts.join("\n");
}

class TopLlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(appConfig: AppConfig) {
    const cfg = appConfig.top_llm || {};
    const apiKeyEnv = cfg.api_key_env || "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing top LLM api key env: ${apiKeyEnv}`);
    }
    const options: { apiKey: string; baseURL?: string; timeout?: number } = { apiKey };
    const resolvedBaseUrl = cfg.base_url || process.env.OPENAI_BASE_URL;
    if (resolvedBaseUrl) {
      options.baseURL = resolvedBaseUrl;
    }
    if (cfg.timeout_ms) {
      options.timeout = cfg.timeout_ms;
    }
    this.client = new OpenAI(options);
    this.model = cfg.model || appConfig.engine.model;
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.client.responses.create({
      model: this.model,
      input: prompt
    });
    return extractOutputText(response);
  }
}

export type Orchestrator = {
  plan: (args: {
    task: string;
    agent: AgentSpec;
    skillLibrary: Skill[];
    adminCap: PermissionProfile;
    currentProfile: PermissionProfile;
    localMemorySummary?: string;
    globalMemorySummary?: string;
  }) => Promise<TopLlmPlanDecision | null>;
  iterate: (args: {
    task: string;
    instruction: string;
    cycle: number;
    maxCycles: number;
    adminCap: PermissionProfile;
    currentProfile: PermissionProfile;
    workerOutput: string;
    userFacingOutput: string;
    errorReason?: string;
    thinking?: string;
    nextAction?: string;
    eventSummary?: string;
    runtimeErrors?: string[];
  }) => Promise<TopLlmIterateDecision | null>;
  approve: (args: {
    task: string;
    request: PermissionRequest;
    adminCap: PermissionProfile;
    commonContext: string;
  }) => Promise<TopLlmApprovalDecision | null>;
  rewrite: (args: {
    task: string;
    style: string;
    workerOutput: string;
  }) => Promise<TopLlmRewriteDecision | null>;
  distill: (args: {
    agentId: string;
    entries: Array<{ ts: string; task: string; status: string; outputSummary: string }>;
  }) => Promise<TopLlmDistillDecision | null>;
  buildCommonContext: typeof buildCommonContext;
};

export function createOrchestrator(appConfig: AppConfig): Orchestrator {
  const client = new TopLlmClient(appConfig);

  return {
    buildCommonContext,

    async plan(args) {
      const commonContext = buildCommonContext({
        adminCap: args.adminCap,
        currentProfile: args.currentProfile,
        localMemorySummary: args.localMemorySummary,
        globalMemorySummary: args.globalMemorySummary
      });
      const prompt = renderPromptTemplate("orchestrator/plan", {
        persona: args.agent.persona.trim(),
        workflow: args.agent.workflow.trim(),
        style: args.agent.style.trim(),
        common_context: commonContext,
        skill_catalog: renderSkillCatalog(args.skillLibrary),
        task: args.task
      });
      const text = await client.complete(prompt);
      const parsed = parseJsonWithSchema(text, planSchema);
      if (!parsed) {
        throw new Error(`planner invalid output: ${truncateForError(text)}`);
      }
      return {
        worker_instruction: parsed.worker_instruction,
        direct_reply: parsed.direct_reply,
        skill_hints: parsed.skill_hints || [],
        required_profile: parsed.required_profile || "safe"
      };
    },

    async iterate(args) {
      const commonContext = buildCommonContext({
        adminCap: args.adminCap,
        currentProfile: args.currentProfile
      });
      const prompt = renderPromptTemplate("orchestrator/iterate", {
        common_context: commonContext,
        task: args.task,
        instruction: args.instruction,
        cycle: String(args.cycle),
        max_cycles: String(args.maxCycles),
        worker_output: args.workerOutput,
        user_facing_output: args.userFacingOutput,
        error_reason: args.errorReason || "none",
        thinking: args.thinking || "none",
        next_action: args.nextAction || "none",
        event_summary: args.eventSummary || "none",
        runtime_errors: args.runtimeErrors && args.runtimeErrors.length > 0
          ? args.runtimeErrors.join("\n")
          : "none"
      });
      const text = await client.complete(prompt);
      const parsed = parseJsonWithSchema(text, iterateSchema);
      if (!parsed) {
        throw new Error(`iterate invalid output: ${truncateForError(text)}`);
      }
      return {
        decision: parsed.decision,
        reason: parsed.reason,
        next_instruction: parsed.next_instruction,
        requested_profile: parsed.requested_profile,
        final_reply: parsed.final_reply
      };
    },

    async approve(args) {
      const prompt = renderPromptTemplate("orchestrator/approve", {
        common_context: args.commonContext,
        task: args.task,
        worker_request: JSON.stringify(args.request),
        admin_cap: args.adminCap
      });
      const text = await client.complete(prompt);
      return parseJsonWithSchema(text, approvalSchema);
    },

    async rewrite(args) {
      const prompt = renderPromptTemplate("orchestrator/rewrite", {
        style: args.style.trim(),
        task: args.task,
        worker_output: args.workerOutput
      });
      const text = await client.complete(prompt);
      return parseJsonWithSchema(text, rewriteSchema);
    },

    async distill(args) {
      const prompt = renderPromptTemplate("orchestrator/distill", {
        agent_id: args.agentId,
        entries_json: JSON.stringify(args.entries)
      });
      const text = await client.complete(prompt);
      const parsed = parseJsonWithSchema(text, distillSchema);
      if (!parsed) {
        return null;
      }
      return {
        personal_memories: parsed.personal_memories || [],
        group_memories: parsed.group_memories || []
      };
    }
  };
}
