import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendGroupVectorMemories,
  appendPersonalVectorMemories,
  appendTemporaryContext,
  compactVectorMemories,
  countTemporaryContext,
  readRecentPersonalVectorMemory,
  recallLayeredMemory,
  resolveMemoryPaths,
  resolveMemoryRuntimeOptions,
  retainTemporaryContext
} from "../src/core/memory/store.js";
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
        dimension: 64,
        personal_recall_top_k: 5,
        group_recall_top_k: 5,
        compaction_similarity_threshold: 0.98,
        max_records: 1000
      },
      temporary: {
        promote_threshold: 4,
        retain_after_promote: 2,
        max_entries: 20
      }
    },
    web: {
      autostart: false,
      host: "127.0.0.1",
      port: 4789
    },
    workflow: {
      max_self_iter_cycles: 6,
      timeout_ms: 600000
    },
    security: {
      default_admin_cap: "workspace"
    }
  };
}

test("layered recall returns temporary + personal + group memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);

  await appendTemporaryContext({
    paths,
    maxEntries: options.temporaryMaxEntries,
    entry: {
      ts: "2026-03-01T00:00:00Z",
      runId: "run-1",
      agentId: "default",
      task: "你叫什么名字",
      status: "ok",
      outputSummary: "我叫小吴"
    }
  });
  await appendPersonalVectorMemories({
    paths,
    options,
    entries: [{
      ts: "2026-03-01T00:00:01Z",
      runId: "run-1",
      agentId: "default",
      text: "用户要求助手称呼为小吴"
    }]
  });
  await appendGroupVectorMemories({
    paths,
    options,
    entries: [{
      ts: "2026-03-01T00:00:02Z",
      runId: "run-1",
      text: "MCP失败后先做最小探测再恢复"
    }]
  });

  const recall = await recallLayeredMemory({
    paths,
    query: "小吴和MCP恢复",
    options,
    temporaryLimit: 8
  });

  assert.equal(recall.temporary.length, 1);
  assert.equal(recall.personalHits.length >= 1, true);
  assert.equal(recall.groupHits.length >= 1, true);
});

test("compactVectorMemories de-duplicates near-identical personal memories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);

  await appendPersonalVectorMemories({
    paths,
    options,
    entries: [
      {
        ts: "2026-03-01T00:00:00Z",
        runId: "run-1",
        agentId: "default",
        text: "发送前先做最小写入探测"
      },
      {
        ts: "2026-03-01T00:00:01Z",
        runId: "run-2",
        agentId: "default",
        text: "发送前先做最小写入探测"
      }
    ]
  });

  const compacted = await compactVectorMemories({
    paths,
    options
  });
  assert.equal(compacted.personal.before >= 2, true);
  assert.equal(compacted.personal.after, 1);
});

test("retainTemporaryContext keeps only latest entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);

  for (let i = 0; i < 6; i += 1) {
    await appendTemporaryContext({
      paths,
      maxEntries: options.temporaryMaxEntries,
      entry: {
        ts: `2026-03-01T00:00:0${i}Z`,
        runId: `run-${i}`,
        agentId: "default",
        task: `task-${i}`,
        status: "ok",
        outputSummary: `summary-${i}`
      }
    });
  }

  await retainTemporaryContext(paths, 2);
  assert.equal(await countTemporaryContext(paths), 2);
  const recentVectors = await readRecentPersonalVectorMemory({
    paths,
    limit: 5,
    options
  });
  assert.equal(Array.isArray(recentVectors), true);
});

test("vector append splits long text and supports embedding fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  config.memory.vector = {
    ...(config.memory.vector || {}),
    embedding: {
      provider: "openai-compatible",
      api_key_env: "MISSING_EMBEDDING_KEY_FOR_TEST",
      fallback_to_deterministic: true,
      timeout_ms: 5
    },
    splitter: {
      enabled: true,
      max_chars: 40,
      overlap_chars: 10,
      min_chunk_chars: 8
    }
  };
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);

  await appendPersonalVectorMemories({
    paths,
    options,
    entries: [{
      ts: "2026-03-02T00:00:00Z",
      runId: "run-long",
      agentId: "default",
      text: "这是一个很长的记忆文本，用于测试文本切分是否生效。我们希望它被拆成多个chunk，然后再写入个人向量库。"
    }]
  });

  const stored = await readRecentPersonalVectorMemory({
    paths,
    limit: 10,
    options
  });
  assert.equal(stored.length >= 2, true);
});

test("appendTemporaryContext is concurrency-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);
  const total = 24;

  await Promise.all(Array.from({ length: total }, (_, i) =>
    appendTemporaryContext({
      paths,
      maxEntries: options.temporaryMaxEntries,
      entry: {
        ts: `2026-03-03T00:00:${String(i).padStart(2, "0")}Z`,
        runId: `run-${i}`,
        agentId: "default",
        task: `task-${i}`,
        status: "ok",
        outputSummary: `summary-${i}`
      }
    })
  ));

  assert.equal(await countTemporaryContext(paths), Math.min(total, options.temporaryMaxEntries));
});

test("appendPersonalVectorMemories is concurrency-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);
  const total = 20;

  await Promise.all(Array.from({ length: total }, (_, i) =>
    appendPersonalVectorMemories({
      paths,
      options,
      entries: [{
        ts: `2026-03-03T00:01:${String(i).padStart(2, "0")}Z`,
        runId: `v-${i}`,
        agentId: "default",
        text: `并发写入记忆 ${i}`
      }]
    })
  ));

  const stored = await readRecentPersonalVectorMemory({
    paths,
    limit: 100,
    options
  });
  assert.equal(stored.length, total);
});

test("layered recall prioritizes temporary context that matches query", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);

  for (let i = 0; i < 12; i += 1) {
    await appendTemporaryContext({
      paths,
      maxEntries: options.temporaryMaxEntries,
      entry: {
        ts: `2026-03-01T00:00:${String(i).padStart(2, "0")}Z`,
        runId: `r-${i}`,
        agentId: "default",
        task: i === 1 ? "用户问了阿宝是谁" : `普通问题-${i}`,
        status: "ok",
        outputSummary: i === 1 ? "阿宝是角色名" : `普通回答-${i}`
      }
    });
  }

  const recall = await recallLayeredMemory({
    paths,
    query: "阿宝",
    options,
    temporaryLimit: 4
  });

  assert.equal(recall.temporary.some((entry) => entry.task.includes("阿宝") || entry.outputSummary.includes("阿宝")), true);
});

test("layered recall can match long chinese query to older temporary entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-memory-vector-"));
  const config = baseConfig(root);
  const paths = resolveMemoryPaths(config, "default");
  const options = resolveMemoryRuntimeOptions(config);

  for (let i = 0; i < 20; i += 1) {
    await appendTemporaryContext({
      paths,
      maxEntries: options.temporaryMaxEntries,
      entry: {
        ts: `2026-03-01T00:10:${String(i).padStart(2, "0")}Z`,
        runId: `older-${i}`,
        agentId: "default",
        task: i === 1 ? "之前用户问过阿宝是谁" : `普通问题-${i}`,
        status: "ok",
        outputSummary: i === 1 ? "阿宝是功夫熊猫角色" : `普通回答-${i}`
      }
    });
  }

  const recall = await recallLayeredMemory({
    paths,
    query: "临时记忆里我刚才问的阿宝这个事情是什么",
    options,
    temporaryLimit: 6
  });

  assert.equal(
    recall.temporary.some((entry) => entry.task.includes("阿宝") || entry.outputSummary.includes("阿宝")),
    true
  );
});
