import test from "node:test";
import assert from "node:assert/strict";
import { toRuntimePermission } from "../src/core/security/permissions.js";

test("toRuntimePermission maps safe/workspace/full profiles", () => {
  assert.deepEqual(toRuntimePermission("safe"), {
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    networkAccessEnabled: false
  });

  assert.deepEqual(toRuntimePermission("workspace"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    networkAccessEnabled: false
  });

  assert.deepEqual(toRuntimePermission("full"), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: true
  });
});
