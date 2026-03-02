import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendGlobalMemory, appendLocalMemory, resolveMemoryPaths } from "../src/core/memory/store.js";
import { shouldRunCompaction } from "../src/core/memory/compaction.js";
import type { AppConfig } from "../src/types/contracts.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-test-"));
  await fn(dir);
}

function baseConfig(root: string): AppConfig {
  return {
    default_policy: "safe-default",
    agent: {
      default_id: "default",
      config_root: "config/agents"
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
      global_store_path: path.join(root, "memory", "global", "distilled.jsonl"),
      compaction: {
        trigger: "on_task_finished",
        token_threshold: 1000
      }
    },
    web: {
      autostart: true,
      host: "127.0.0.1",
      port: 4789
    },
    workflow: {
      max_capability_attempts: 3,
      capability_timeout_ms: 600000,
      enable_skill_manager: true,
      allow_promote_to_config_skills: true
    },
    security: {
      default_admin_cap: "workspace"
    }
  };
}

test("memory store appends local and global entries", async () => {
  await withTempDir(async (dir) => {
    const config = baseConfig(dir);
    const paths = resolveMemoryPaths(config, "default");
    await appendLocalMemory(paths, {
      ts: "2026-01-01T00:00:00Z",
      runId: "run-1",
      agentId: "default",
      task: "task",
      status: "ok",
      outputSummary: "done"
    });
    const appended = await appendGlobalMemory(paths, [{
      ts: "2026-01-01T00:00:00Z",
      sourceAgentId: "default",
      runId: "run-1",
      memory: "Always verify outputs."
    }]);
    assert.equal(appended, 1);

    const localRaw = await readFile(paths.localPath, "utf8");
    const globalRaw = await readFile(paths.globalPath, "utf8");
    assert.match(localRaw, /"runId":"run-1"/);
    assert.match(globalRaw, /Always verify outputs/);
  });
});

test("shouldRunCompaction supports token threshold mode", () => {
  const config = baseConfig("/tmp/x");
  config.memory.compaction.trigger = "token_threshold";
  config.memory.compaction.token_threshold = 100;
  assert.equal(
    shouldRunCompaction({
      appConfig: config,
      result: {
        status: "ok",
        outputText: "",
        usage: { total_tokens: 120 }
      }
    }),
    true
  );
});
