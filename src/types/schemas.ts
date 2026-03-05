import { z } from "zod";

export const agentSchema = z.object({
  id: z.string().min(1),
  system_prompt: z.string().min(1),
  style: z.string().optional(),
  default_skills: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  summary: z.string().optional(),
  keywords: z.array(z.string()).default([])
});

export const skillMetaSchema = z.object({
  trigger: z
    .object({
      keywords: z.array(z.string()).optional(),
      file_globs: z.array(z.string()).optional()
    })
    .default({}),
  channel: z
    .object({
      kind: z.string().min(1),
      entrypoint: z.string().min(1).optional(),
      requires_env: z.array(z.string()).optional()
    })
    .optional(),
  selector: z
    .object({
      short: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      usage_hint: z.string().optional()
    })
    .optional(),
  inject_mode: z.enum(["prepend", "append"]).default("prepend"),
  limits: z
    .object({
      max_tokens: z.number().int().positive().optional()
    })
    .optional(),
  summary: z.string().optional(),
  trust_tier: z.enum(["certified", "popular", "standard", "untrusted"]).optional(),
  source_ref: z.string().optional(),
  popularity: z
    .object({
      uses: z.number().int().nonnegative().default(0),
      success_rate: z.number().min(0).max(1).default(0)
    })
    .optional(),
  repair_role: z.enum(["normal", "repair"]).optional()
});

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  metadata: skillMetaSchema.default({})
});

export const policySchema = z.object({
  id: z.string().min(1),
  sandbox: z.object({
    mode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    approval_policy: z.enum(["never", "on-request", "on-failure", "untrusted"]).default("on-request")
  }),
  network: z.object({
    enabled: z.boolean().default(false)
  })
});

export const appConfigSchema = z.object({
  default_agent: z.string().min(1).optional(),
  default_policy: z.string().min(1),
  agent: z
    .object({
      default_id: z.string().min(1).default("default"),
      config_root: z.string().min(1).default("user/agents")
    })
    .default({}),
  engine: z.object({
    provider: z.literal("codex-sdk").default("codex-sdk"),
    model: z.string().min(1),
    cli_command: z.string().min(1).default("codex"),
    cli_args: z.array(z.string()).default([]),
    codex_home: z.string().min(1).optional(),
    unset_codex_sandbox_env: z.boolean().default(false),
    timeout_ms: z.number().int().positive().default(120000)
  }),
  top_llm: z
    .object({
      base_url: z.string().min(1).optional(),
      api_key_env: z.string().min(1).default("OPENAI_API_KEY"),
      model: z.string().min(1).optional(),
      timeout_ms: z.number().int().positive().default(120000)
    })
    .default({}),
  memory: z
    .object({
      local_store_root: z.string().min(1).default("user/memory/agents"),
      global_vector_store_path: z.string().min(1).default("user/memory/global/group-vector.json"),
      vector: z
        .object({
          dimension: z.number().int().positive().default(96),
          personal_recall_top_k: z.number().int().positive().default(6),
          group_recall_top_k: z.number().int().positive().default(6),
          compaction_similarity_threshold: z.number().min(0).max(1).default(0.97),
          max_records: z.number().int().positive().default(5000),
          embedding: z
            .object({
              provider: z.enum(["deterministic", "openai-compatible"]).default("deterministic"),
              base_url: z.string().min(1).default("https://open.bigmodel.cn/api/paas/v4"),
              model: z.string().min(1).default("embedding-3"),
              api_key_env: z.string().min(1).default("EMBEDDING_API_KEY"),
              timeout_ms: z.number().int().positive().default(20000),
              fallback_to_deterministic: z.boolean().default(true)
            })
            .default({}),
          splitter: z
            .object({
              enabled: z.boolean().default(true),
              max_chars: z.number().int().positive().default(400),
              overlap_chars: z.number().int().nonnegative().default(60),
              min_chunk_chars: z.number().int().positive().default(20)
            })
            .default({})
        })
        .default({}),
      temporary: z
        .object({
          promote_threshold: z.number().int().positive().default(24),
          retain_after_promote: z.number().int().positive().default(12),
          max_entries: z.number().int().positive().default(200)
        })
        .default({})
    })
    .default({}),
  web: z
    .object({
      autostart: z.boolean().default(true),
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(4789)
    })
    .default({}),
  channels: z
    .object({
      enabled: z.boolean().default(true),
      config_path: z.string().min(1).default("src/config/channels.yaml"),
      state_db_path: z.string().min(1).default("user/channels/channels.db"),
      poll_interval_ms: z.number().int().positive().default(2000),
      max_inflight: z.number().int().positive().default(4)
    })
    .default({}),
  workflow: z
    .object({
      execution_mode: z.literal("execute-first").default("execute-first"),
      autonomy_profile: z.enum(["aggressive", "balanced", "tight"]).default("aggressive"),
      max_self_iter_cycles: z.number().int().positive().default(6),
      max_permission_attempts: z.number().int().positive().default(3),
      max_repair_attempts: z.number().int().positive().default(4),
      max_total_minutes: z.number().int().positive().default(20),
      timeout_ms: z.number().int().positive().default(600000)
    })
    .default({}),
  security: z
    .object({
      default_admin_cap: z.enum(["safe", "workspace", "full"]).default("workspace"),
      trust_scope: z.enum(["certified-only", "certified-popular", "all"]).default("certified-popular"),
      admin_stamp_path: z.string().min(1).default("src/config/security/admin-steel-stamp.md")
    })
    .default({}),
  evolution: z
    .object({
      policy_update_enabled: z.boolean().default(true),
      risky_gate_enabled: z.boolean().default(true)
    })
    .default({})
});
