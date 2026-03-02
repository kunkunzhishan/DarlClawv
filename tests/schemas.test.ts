import test from "node:test";
import assert from "node:assert/strict";
import { agentSchema, appConfigSchema, policySchema, skillFrontmatterSchema } from "../src/types/schemas.js";

test("agent schema validates required fields", () => {
  const parsed = agentSchema.parse({
    id: "default",
    system_prompt: "x",
    default_skills: [],
    constraints: []
  });
  assert.equal(parsed.id, "default");
});

test("skill frontmatter schema rejects invalid inject_mode", () => {
  assert.throws(() =>
    skillFrontmatterSchema.parse({
      name: "s1",
      description: "desc",
      metadata: {
        inject_mode: "middle"
      }
    })
  );
});

test("policy schema allows safe defaults", () => {
  const parsed = policySchema.parse({
    id: "safe",
    sandbox: { mode: "read-only", approval_policy: "on-request" },
    network: { enabled: false }
  });
  assert.equal(parsed.network.enabled, false);
});

test("app config schema supports agent and memory defaults", () => {
  const parsed = appConfigSchema.parse({
    default_policy: "safe-default",
    agent: {
      default_id: "default",
      config_root: "config/agents"
    },
    engine: {
      provider: "codex-sdk",
      model: "gpt-5-codex"
    }
  });

  assert.equal(parsed.agent.default_id, "default");
  assert.equal(parsed.memory.global_vector_store_path, ".darlclawv-runtime/memory/global/group-vector.json");
  assert.equal(parsed.memory.vector.dimension, 96);
  assert.equal(parsed.memory.vector.embedding.provider, "deterministic");
  assert.equal(parsed.memory.vector.splitter.max_chars, 400);
  assert.equal(parsed.memory.temporary.promote_threshold, 24);
  assert.equal(parsed.workflow.max_capability_attempts, 1);
  assert.equal(parsed.security.default_admin_cap, "workspace");
});
