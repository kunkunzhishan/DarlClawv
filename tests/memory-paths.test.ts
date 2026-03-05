import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveMemoryPaths, resolveMemoryRuntimeOptions } from "../src/core/memory/store.js";
import type { AppConfig } from "../src/types/contracts.js";

function baseConfig(root: string): AppConfig {
  return {
    default_policy: "safe-default",
    agent: {
      default_id: "default",
      config_root: "user/agents"
    },
    engine: {
      provider: "codex-sdk",
      model: "gpt-5-codex",
      cli_command: "codex",
      cli_args: [],
      timeout_ms: 120000
    },
    memory: {
      local_store_root: path.join(root, "memory", "agents"),
      global_vector_store_path: path.join(root, "memory", "global", "group-vector.json"),
      vector: {
        dimension: 64
      },
      temporary: {
        promote_threshold: 6,
        retain_after_promote: 3,
        max_entries: 20
      }
    },
    web: {
      autostart: true,
      host: "127.0.0.1",
      port: 4789
    },
    channels: {
      enabled: false,
      config_path: "src/config/channels.yaml",
      state_db_path: path.join(root, "channels", "channels.db"),
      poll_interval_ms: 2000,
      max_inflight: 2
    },
    workflow: {
      execution_mode: "execute-first",
      autonomy_profile: "aggressive",
      max_self_iter_cycles: 6,
      max_permission_attempts: 3,
      max_repair_attempts: 4,
      max_total_minutes: 20,
      timeout_ms: 600000
    },
    security: {
      default_admin_cap: "workspace",
      trust_scope: "certified-popular"
    },
    evolution: {
      policy_update_enabled: true,
      risky_gate_enabled: true
    }
  };
}

test("resolveMemoryPaths keeps only temporary + personal + group vector stores", () => {
  const config = baseConfig("/tmp/darlclawv-memory");
  const paths = resolveMemoryPaths(config, "default");
  assert.equal(paths.temporaryContextPath.endsWith("/memory/agents/default/temporary-context.json"), true);
  assert.equal(paths.personalVectorPath.endsWith("/memory/agents/default/personal-vector.json"), true);
  assert.equal(paths.groupVectorPath.endsWith("/memory/global/group-vector.json"), true);
});

test("resolveMemoryRuntimeOptions parses temporary promotion options", () => {
  const config = baseConfig("/tmp/darlclawv-memory");
  const options = resolveMemoryRuntimeOptions(config);
  assert.equal(options.temporaryPromoteThreshold, 6);
  assert.equal(options.temporaryRetainAfterPromote, 3);
  assert.equal(options.temporaryMaxEntries, 20);
});
