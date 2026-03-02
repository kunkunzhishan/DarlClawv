import test from "node:test";
import assert from "node:assert/strict";
import { decidePermissionByAdmin } from "../src/core/security/admin-approver.js";
import type { PermissionRequest } from "../src/types/contracts.js";

test("decidePermissionByAdmin returns admin JSON decision directly", async () => {
  const request: PermissionRequest = {
    type: "PERMISSION_REQUEST",
    requested_profile: "workspace",
    reason: "need file writes"
  };

  const sdkClient = {
    startThread: () => ({ id: null }),
    runThread: async () => ({
      outputText: JSON.stringify({ decision: "grant", profile: "full", reason: "ok" }),
      threadId: null
    })
  } as any;

  const decision = await decidePermissionByAdmin({
    sdkClient,
    task: "fix build",
    request,
    adminCap: "workspace"
  });

  assert.equal(decision.decision, "grant");
  assert.equal(decision.profile, "full");
});

test("decidePermissionByAdmin does not short-circuit by cap in code", async () => {
  const request: PermissionRequest = {
    type: "PERMISSION_REQUEST",
    requested_profile: "full",
    reason: "need full access"
  };

  let called = false;
  const sdkClient = {
    startThread: () => ({ id: null }),
    runThread: async () => {
      called = true;
      return { outputText: JSON.stringify({ decision: "escalate", profile: "full", reason: "need user confirm" }), threadId: null };
    }
  } as any;

  const decision = await decidePermissionByAdmin({
    sdkClient,
    task: "install system deps",
    request,
    adminCap: "workspace"
  });

  assert.equal(decision.decision, "escalate");
  assert.equal(called, true);
});
