import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCapabilityFailed,
  parseCapabilityReady,
  parseCapabilityRequest,
  parseCapabilityProtocolMessage
} from "../src/core/skill-manager/protocol.js";

test("parseCapabilityRequest parses plain JSON", () => {
  const parsed = parseCapabilityRequest(
    JSON.stringify({
      type: "CAPABILITY_REQUEST",
      capability_id: "repo.report",
      goal: "Generate repo report",
      io_contract: "input:repo path output:markdown",
      acceptance_tests: ["returns markdown"]
    })
  );

  assert.ok(parsed);
  assert.equal(parsed?.capability_id, "repo.report");
});

test("parseCapabilityReady parses fenced json", () => {
  const parsed = parseCapabilityReady(`\n\n\`\`\`json\n${JSON.stringify({
    type: "CAPABILITY_READY",
    capability_id: "repo.report",
    entrypoint: "node scripts/repo-report.js",
    skill_path: "/tmp/runtime/repo-report",
    tests_passed: true,
    evidence: {
      test_command: "npm test",
      test_result_summary: "pass"
    }
  })}\n\`\`\``);

  assert.ok(parsed);
  assert.equal(parsed?.tests_passed, true);
  assert.equal(parsed?.evidence?.test_command, "npm test");
});

test("parseCapabilityReady rejects payload without required evidence", () => {
  const parsed = parseCapabilityReady(
    JSON.stringify({
      type: "CAPABILITY_READY",
      capability_id: "repo.report",
      entrypoint: "node scripts/repo-report.js",
      skill_path: "/tmp/runtime/repo-report",
      tests_passed: true
    })
  );
  assert.equal(parsed, null);
});

test("parseCapabilityFailed returns failed payload", () => {
  const parsed = parseCapabilityFailed(
    JSON.stringify({
      type: "CAPABILITY_FAILED",
      capability_id: "repo.report",
      error: "test failed",
      attempts: 3
    })
  );

  assert.ok(parsed);
  assert.equal(parsed?.attempts, 3);
});

test("parseCapabilityProtocolMessage returns null for malformed payload", () => {
  const parsed = parseCapabilityProtocolMessage("not-json");
  assert.equal(parsed, null);
});
