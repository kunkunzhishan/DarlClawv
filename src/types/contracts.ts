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
    max_capability_attempts: number;
    capability_timeout_ms: number;
    enable_skill_manager: boolean;
    allow_promote_to_config_skills: boolean;
  };
  security: {
    default_admin_cap: PermissionProfile;
    admin_stamp_path?: string;
  };
};

export type RunRequest = {
  agentId?: string;
  task: string;
  policyId?: string;
  adminCap?: PermissionProfile;
  runMode?: RunMode;
  workflowId?: string;
  disableSkillManager?: boolean;
  taskWorkspace?: string;
  controlPlaneRoot?: string;
};

export type FailureKind = "auth" | "network" | "model" | "tool" | "unknown";

export type CapabilityRequest = {
  type: "CAPABILITY_REQUEST";
  capability_id: string;
  goal: string;
  io_contract: string;
  acceptance_tests: string[];
  constraints?: string[];
  promote_to_config_skills?: boolean;
};

export type CapabilityReady = {
  type: "CAPABILITY_READY";
  capability_id: string;
  entrypoint: string;
  skill_path: string;
  tests_passed: boolean;
  report?: string;
  evidence: {
    test_command: string;
    test_result_summary: string;
    external_receipt?: string;
    side_effect_kind?: "none" | "external_message" | "external_api" | "other";
  };
};

export type CapabilityFailed = {
  type: "CAPABILITY_FAILED";
  capability_id: string;
  error: string;
  attempts: number;
};

export type CapabilityFeedback = {
  type: "CAPABILITY_FEEDBACK";
  capability_id: string;
  ok: boolean;
  error?: string;
};

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

export type TopLlmPlanDecision = {
  worker_instruction?: string;
  direct_reply?: string;
  skill_hints: string[];
  required_profile: PermissionProfile;
};

export type TopLlmApprovalDecision = {
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

export type CapabilityProtocolMessage =
  | CapabilityRequest
  | CapabilityReady
  | CapabilityFailed
  | CapabilityFeedback;

export type CapabilityResult = {
  status: "ready" | "failed";
  capability_id: string;
  entrypoint?: string;
  skill_path?: string;
  tests_passed?: boolean;
  report?: string;
  evidence?: CapabilityReady["evidence"];
  error?: string;
  attempts: number;
};

export type PromotionRequest = {
  runId: string;
  capabilityId: string;
};

export type ThreadBinding = {
  main: string;
};

export type WorkflowPhase =
  | "started"
  | "running-main"
  | "resolving-capability"
  | "finished"
  | "failed";

export type WorkflowState = {
  workflowId: string;
  runId: string;
  phase: WorkflowPhase;
  threadBindings: Partial<ThreadBinding>;
  attemptsByCapability: Record<string, number>;
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
  | { type: "thread.created"; role: keyof ThreadBinding; threadId: string; ts: string }
  | { type: "thread.resumed"; role: keyof ThreadBinding; threadId: string; ts: string }
  | { type: "prompt.compiled"; size: number; ts: string }
  | { type: "engine.delta"; chunk: string; ts: string }
  | { type: "runner.started"; pid: number; ts: string }
  | { type: "runner.stdout"; line: string; ts: string }
  | { type: "runner.stderr"; line: string; ts: string }
  | { type: "runner.exited"; code: number; ts: string }
  | { type: "capability.requested"; workflowId: string; capabilityId: string; ts: string }
  | { type: "capability.resolve.started"; workflowId: string; capabilityId: string; ts: string }
  | { type: "capability.resolve.attempt"; workflowId: string; capabilityId: string; attempt: number; ts: string }
  | {
      type: "capability.ready";
      workflowId: string;
      capabilityId: string;
      entrypoint: string;
      skillPath: string;
      evidence?: CapabilityReady["evidence"];
      ts: string;
    }
  | {
      type: "capability.failed";
      workflowId: string;
      capabilityId: string;
      attempts: number;
      reason: string;
      ts: string;
    }
  | {
      type: "capability.promotion.pending";
      workflowId: string;
      capabilityId: string;
      sourcePath: string;
      ts: string;
    }
  | {
      type: "capability.promoted";
      workflowId: string;
      capabilityId: string;
      targetPath: string;
      ts: string;
    }
  | {
      type: "skills.selected";
      agentId: string;
      selectedSkillIds: string[];
      mode: "llm" | "fallback";
      reason?: string;
      ts: string;
    }
  | { type: "capability.validation.failed"; workflowId: string; capabilityId: string; reason: string; ts: string }
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
      type: "repair.triggered";
      workflowId: string;
      capabilityId: string;
      reason: "install-intent" | "failure-signal";
      ts: string;
    }
  | {
      type: "repair.priority.selected";
      workflowId: string;
      capabilityId: string;
      layer: "certified-popular" | "standard" | "script-fallback";
      selectedSkillIds: string[];
      ts: string;
    }
  | {
      type: "repair.source.rejected";
      workflowId: string;
      capabilityId: string;
      sourceRef: string;
      reason: string;
      ts: string;
    }
  | {
      type: "repair.validation.failed";
      workflowId: string;
      capabilityId: string;
      reason: string;
      ts: string;
    }
  | {
      type: "repair.completed";
      workflowId: string;
      capabilityId: string;
      status: "ready" | "failed";
      attempts: number;
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
