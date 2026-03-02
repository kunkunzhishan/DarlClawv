import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../src/core/policy-engine/index.js";
import type { Policy } from "../src/types/contracts.js";

test("evaluatePolicy denies when deny pattern matches", () => {
  const policy: Policy = {
    id: "p",
    fs: { mode: "workspace-write" },
    shell: {
      allow: [],
      deny: ["rm -rf"],
      confirm_on: ["git reset --hard"]
    },
    network: { enabled: false }
  };

  const result = evaluatePolicy("please run rm -rf tmp", policy);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.length > 0);
});

test("evaluatePolicy marks confirmations", () => {
  const policy: Policy = {
    id: "p",
    fs: { mode: "workspace-write" },
    shell: {
      allow: [],
      deny: [],
      confirm_on: ["git reset --hard"]
    },
    network: { enabled: true }
  };

  const result = evaluatePolicy("use git reset --hard", policy);
  assert.equal(result.ok, true);
  assert.deepEqual(result.confirmations, ["git reset --hard"]);
});
