import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access } from "node:fs/promises";
import { loadAgentPack } from "../src/registry/agent-pack.js";

test("loadAgentPack handles legacy compatibility packs", async () => {
  const mainPackPath = path.resolve("config", "agent-packs", "main-worker");
  const hasMainPack = await access(mainPackPath).then(() => true).catch(() => false);

  if (!hasMainPack) {
    await assert.rejects(async () => {
      await loadAgentPack("main-worker");
    });
    return;
  }

  const pack = await loadAgentPack("main-worker");
  assert.equal(pack.id, "main-worker");
  assert.ok(pack.persona.length > 0);
  assert.ok(pack.workflow.length > 0);
  assert.ok(pack.style.length > 0);
  assert.ok(pack.ioContract.length > 0);
  assert.ok(pack.skills.length > 0);
  assert.ok(pack.skillWhitelist.length > 0);
});
