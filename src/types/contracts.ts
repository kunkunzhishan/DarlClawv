export type AgentProfile = {
  id: string;
  system_prompt: string;
  style?: string;
  default_skills: string[];
  constraints: string[];
  summary?: string;
  keywords?: string[];
};

export type AgentSpec = {
  id: string;
  summary?: string;
  persona: string;
  workflow: string;
  style: string;
  capabilityPolicy: string;
  skillWhitelist: string[];
  path: string;
};

export type SkillMeta = {
  name: string;
  description: string;
  protocol: "codex-skill-v1";
  trigger: {
    keywords?: string[];
    file_globs?: string[];
  };
  selector?: {
    short?: string;
    aliases?: string[];
    tags?: string[];
    usage_hint?: string;
  };
  inject_mode: "prepend" | "append";
  limits?: {
    max_tokens?: number;
  };
  summary?: string;
  trust_tier?: "certified" | "popular" | "standard" | "untrusted";
  source_ref?: string;
  popularity?: {
    uses: number;
    success_rate: number;
  };
  repair_role?: "normal" | "repair";
};

export type Skill = {
  id: string;
  meta: SkillMeta;
  body: string;
  path: string;
  package?: {
    root: string;
    manifestPath?: string;
    entrypoint?: string;
    testCommand?: string;
    status?: "active" | "draft" | "disabled";
  };
};

export type SkillRecommendedSource = {
  id: string;
  kind: "skill" | "mcp";
  url?: string;
  domain?: string;
  trust_tier: "certified" | "popular" | "standard" | "untrusted";
  enabled: boolean;
};

export type PermissionProfile = "safe" | "workspace" | "full";
export type RunMode = "managed" | "direct";
export type AutonomyProfile = "aggressive" | "balanced" | "tight";
export type TrustScope = "certified-only" | "certified-popular" | "all";

export type Policy = {
  id: string;
  sandbox: {
    mode: "read-only" | "workspace-write" | "danger-full-access";
    approval_policy: "never" | "on-request" | "on-failure" | "untrusted";
  };
  network: {
    enabled: boolean;
  };
};

export type AppConfig = {
  default_agent?: string;
  default_policy: string;
  agent: {
    default_id: string;
    config_root: string;
  };
  engine: {
    provider: "codex-sdk";
    model: string;
    // Legacy fields retained for backward compatibility with deprecated runner path.
    cli_command: string;
    cli_args: string[];
    codex_home?: string;
    unset_codex_sandbox_env?: boolean;
    timeout_ms: number;
  };
  top_llm?: {
    base_url?: string;
    api_key_env?: string;
    model?: string;
    timeout_ms?: number;
  };
  memory: {
    local_store_root: string;
    global_vector_store_path: string;
    vector?: {
      dimension?: number;
      personal_recall_top_k?: number;
      group_recall_top_k?: number;
      compaction_similarity_threshold?: number;
      max_records?: number;
      embedding?: {
        provider?: "deterministic" | "openai-compatible";
        base_url?: string;
        model?: string;
        api_key_env?: string;
        timeout_ms?: number;
        fallback_to_deterministic?: boolean;
      };
      splitter?: {
        enabled?: boolean;
        max_chars?: number;
        overlap_chars?: number;
        min_chunk_chars?: number;
      };
    };
    temporary?: {
      promote_threshold?: number;
      retain_after_promote?: number;
      max_entries?: number;
    };
  };
  web: {
    autostart: boolean;
    host: string;
    port: number;
  };
  workflow: {
    execution_mode: "execute-first";
    autonomy_profile: AutonomyProfile;
    max_self_iter_cycles: number;
    max_permission_attempts: number;
    max_repair_attempts: number;
    max_total_minutes: number;
    timeout_ms: number;
  };
  security: {
    default_admin_cap: PermissionProfile;
    trust_scope: TrustScope;
    admin_stamp_path?: string;
  };
  evolution: {
    policy_update_enabled: boolean;
    risky_gate_enabled: boolean;
  };
};

export type RunRequest = {
  agentId?: string;
  task: string;
  policyId?: string;
  adminCap?: PermissionProfile;
  // Deprecated: runMode retained for backward compatibility.
  runMode?: RunMode;
  autonomyProfile?: AutonomyProfile;
  workflowId?: string;
  taskWorkspace?: string;
  controlPlaneRoot?: string;
};

export type FailureKind = "auth" | "network" | "model" | "tool" | "unknown";

export type WorkerTurnContext = {
  cycle: number;
  maxCycles: number;
  instruction: string;
  workerOutput: string;
  userFacingOutput: string;
  errorReason?: string;
  thinking?: string;
  nextAction?: string;
  eventSummary?: string;
  runtimeErrors?: string[];
};

// Deprecated: capability protocol remains for backward compatibility, but not used by main loop.
// Deprecated: permission protocol remains for backward compatibility, but not used by main loop.
export type PermissionRequest = {
  type: "PERMISSION_REQUEST";
  requested_profile: PermissionProfile;
  reason: string;
};

export type PermissionDecision = {
  decision: "grant" | "deny" | "escalate";
  profile: PermissionProfile;
  reason: string;
};

export type TopLlmRewriteDecision = {
  final_reply: string;
};

export type TopLlmDistillDecision = {
  personal_memories: string[];
  group_memories: string[];
};

export type StrategyStatsRecord = {
  skill_id: string;
  scenario_tag: string;
  attempts: number;
  successes: number;
  avg_latency_ms: number;
  last_error_kind?: string;
  updated_at: string;
};

export type RecoveryDecision =
  | {
      status: "repaired";
      skillId: string;
      scenarioTag: string;
      summary: string;
      elapsedMs: number;
    }
  | {
      status: "not_repairable";
      scenarioTag: string;
      reason: string;
      elapsedMs: number;
    }
  | {
      status: "need_user_gate";
      skillId: string;
      scenarioTag: string;
      reason: string;
      elapsedMs: number;
    };

export type ThreadBinding = {
  main: string;
};

export type WorkflowPhase =
  | "started"
  | "running-main"
  | "finished"
  | "failed";

export type WorkflowState = {
  workflowId: string;
  runId: string;
  phase: WorkflowPhase;
  threadBindings: Partial<ThreadBinding>;
  startedAt: string;
  updatedAt: string;
  deadlineAt: string;
};

export type RuntimeLibraryPaths = {
  root: string;
  scriptsDir: string;
  mcpDir: string;
  testsDir: string;
  logsDir: string;
  indexPath: string;
};

export type RunEvent =
  | { type: "run.started"; runId: string; ts: string }
  | { type: "workflow.started"; workflowId: string; ts: string }
  | { type: "workflow.phase.changed"; workflowId: string; phase: WorkflowPhase; ts: string }
  | {
      type: "execution.blocked";
      runId: string;
      kind: "permission" | "capability" | "environment";
      reason: string;
      ts: string;
    }
  | { type: "iteration.started"; runId: string; cycle: number; ts: string }
  | { type: "iteration.worker.completed"; runId: string; cycle: number; ts: string }
  | {
      type: "iteration.decided";
      runId: string;
      cycle: number;
      decision: "retry" | "escalate" | "finish" | "abort";
      reason: string;
      requestedProfile?: PermissionProfile;
      ts: string;
    }
  | { type: "iteration.exhausted"; runId: string; maxCycles: number; ts: string }
  | { type: "iteration.aborted"; runId: string; cycle: number; reason: string; ts: string }
  | { type: "thread.created"; role: keyof ThreadBinding; threadId: string; ts: string }
  | { type: "thread.resumed"; role: keyof ThreadBinding; threadId: string; ts: string }
  | { type: "prompt.compiled"; size: number; ts: string }
  | { type: "engine.delta"; chunk: string; ts: string }
  | { type: "runner.started"; pid: number; ts: string }
  | { type: "runner.stdout"; line: string; ts: string }
  | { type: "runner.stderr"; line: string; ts: string }
  | { type: "runner.exited"; code: number; ts: string }
  | {
      type: "skills.selected";
      agentId: string;
      selectedSkillIds: string[];
      mode: "llm" | "fallback";
      reason?: string;
      ts: string;
    }
  | { type: "permission.requested"; runId: string; requestedProfile: PermissionProfile; reason: string; ts: string }
  | {
      type: "permission.admin.decided";
      runId: string;
      decision: "grant" | "deny" | "escalate";
      requestedProfile: PermissionProfile;
      grantedProfile: PermissionProfile;
      reason: string;
      ts: string;
    }
  | {
      type: "permission.user.decided";
      runId: string;
      approved: boolean;
      requestedProfile: PermissionProfile;
      grantedProfile?: PermissionProfile;
      reason: string;
      ts: string;
    }
  | {
      type: "recovery.started";
      runId: string;
      scenarioTag: string;
      reason: string;
      ts: string;
    }
  | {
      type: "recovery.candidate.selected";
      runId: string;
      skillId: string;
      trustTier: "certified" | "popular" | "standard" | "untrusted";
      ts: string;
    }
  | { type: "recovery.test.passed"; runId: string; skillId: string; summary: string; ts: string }
  | { type: "recovery.test.failed"; runId: string; skillId: string; reason: string; ts: string }
  | {
      type: "recovery.finished";
      runId: string;
      status: "repaired" | "not_repairable" | "need_user_gate";
      summary: string;
      ts: string;
    }
  | {
      type: "strategy.updated";
      runId: string;
      skillId: string;
      scenarioTag: string;
      attempts: number;
      successes: number;
      ts: string;
    }
  | { type: "memory.compaction.started"; runId: string; agentId: string; trigger: string; ts: string }
  | { type: "memory.compaction.finished"; runId: string; agentId: string; compacted: boolean; ts: string }
  | {
      type: "memory.vector.group.appended";
      runId: string;
      agentId: string;
      count: number;
      ts: string;
    }
  | { type: "tool.called"; name: string; args: unknown; ts: string }
  | { type: "tool.result"; name: string; ok: boolean; ts: string }
  | { type: "run.finished"; status: "ok" | "failed"; cost?: number; ts: string }
  | { type: "run.error"; message: string; ts: string };

export type CompiledPrompt = {
  system: string;
  developer: string;
  user: string;
  fullText: string;
  size: number;
};

export type EngineRunResult = {
  status: "ok" | "failed";
  outputText: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
  exitCode?: number;
  failureKind?: FailureKind;
};
