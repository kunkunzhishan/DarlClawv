import test from "node:test";
import assert from "node:assert/strict";
import { parsePermissionDecision, parsePermissionRequest } from "../src/core/security/protocol.js";

test("parsePermissionRequest parses JSON payload", () => {
  const parsed = parsePermissionRequest(
    JSON.stringify({
      type: "PERMISSION_REQUEST",
      requested_profile: "workspace",
      reason: "need write access"
    })
  );

  assert.equal(parsed?.type, "PERMISSION_REQUEST");
  assert.equal(parsed?.requested_profile, "workspace");
});

test("parsePermissionDecision parses fenced JSON payload", () => {
  const parsed = parsePermissionDecision(
    "```json\n" +
      JSON.stringify({
        decision: "grant",
        profile: "workspace",
        reason: "minimal access"
      }) +
      "\n```"
  );

  assert.equal(parsed?.decision, "grant");
  assert.equal(parsed?.profile, "workspace");
});

test("parsePermissionDecision returns null for malformed payload", () => {
  const parsed = parsePermissionDecision("{\"decision\":\"grant\"}");
  assert.equal(parsed, null);
});
