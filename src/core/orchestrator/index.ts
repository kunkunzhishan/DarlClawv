import OpenAI from "openai";
import { z } from "zod";
import { renderPromptTemplate } from "../../registry/prompt-templates.js";
import type { AppConfig, TopLlmDistillDecision, TopLlmRewriteDecision } from "../../types/contracts.js";

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
  rewrite: (args: {
    task: string;
    style: string;
    workerOutput: string;
  }) => Promise<TopLlmRewriteDecision | null>;
  distill: (args: {
    agentId: string;
    entries: Array<{ ts: string; task: string; status: string; outputSummary: string }>;
  }) => Promise<TopLlmDistillDecision | null>;
};

export function createOrchestrator(appConfig: AppConfig): Orchestrator {
  const client = new TopLlmClient(appConfig);
  return {
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
