import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readStrategyStats, strategyBonusForSkill, updateStrategyStats } from "../src/core/strategy/stats.js";

test("updateStrategyStats persists attempts/successes and rolling latency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-strategy-"));
  const statsPath = path.join(root, "strategy-stats.json");

  const first = await updateStrategyStats({
    pathValue: statsPath,
    skillId: "mcp-recovery",
    scenarioTag: "web-capability",
    success: true,
    latencyMs: 1200
  });
  assert.equal(first.attempts, 1);
  assert.equal(first.successes, 1);
  assert.equal(first.avg_latency_ms, 1200);

  const second = await updateStrategyStats({
    pathValue: statsPath,
    skillId: "mcp-recovery",
    scenarioTag: "web-capability",
    success: false,
    latencyMs: 800
  });
  assert.equal(second.attempts, 2);
  assert.equal(second.successes, 1);
  assert.equal(second.avg_latency_ms, 1000);

  const onDisk = JSON.parse(await readFile(statsPath, "utf8")) as { records: Array<{ attempts: number }> };
  assert.equal(onDisk.records.length, 1);
  assert.equal(onDisk.records[0]?.attempts, 2);
});

test("strategyBonusForSkill favors successful low-latency records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-strategy-"));
  const statsPath = path.join(root, "strategy-stats.json");

  for (let i = 0; i < 4; i += 1) {
    await updateStrategyStats({
      pathValue: statsPath,
      skillId: "mcp-recovery",
      scenarioTag: "web-capability",
      success: true,
      latencyMs: 500
    });
  }
  await updateStrategyStats({
    pathValue: statsPath,
    skillId: "slow-skill",
    scenarioTag: "web-capability",
    success: true,
    latencyMs: 5000
  });

  const doc = await readStrategyStats(statsPath);
  const fastBonus = strategyBonusForSkill({
    records: doc.records,
    skillId: "mcp-recovery",
    scenarioTag: "web-capability"
  });
  const slowBonus = strategyBonusForSkill({
    records: doc.records,
    skillId: "slow-skill",
    scenarioTag: "web-capability"
  });

  assert.equal(fastBonus > slowBonus, true);
});
