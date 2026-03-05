import test from "node:test";
import assert from "node:assert/strict";
import { runRecoveryManager } from "../src/core/recovery/manager.js";
import type { AgentSpec, Policy, Skill } from "../src/types/contracts.js";

function makeSkill(id: string, trust: Skill["meta"]["trust_tier"], repairRole: "repair" | "normal"): Skill {
  return {
    id,
    path: `/tmp/${id}/SKILL.md`,
    body: `# ${id}`,
    meta: {
      name: id,
      description: `${id} description`,
      protocol: "codex-skill-v1",
      trigger: {},
      inject_mode: "prepend",
      trust_tier: trust,
      repair_role: repairRole
    }
  };
}

const spec: AgentSpec = {
  id: "default",
  summary: "test",
  persona: "persona",
  workflow: "workflow",
  style: "style",
  capabilityPolicy: "dynamic-skill-selection",
  skillWhitelist: [],
  path: "/tmp/agent.md"
};

const policy: Policy = {
  id: "workspace-default",
  sandbox: {
    mode: "workspace-write",
    approval_policy: "on-request"
  },
  network: {
    enabled: false
  }
};

test("runRecoveryManager escalates to user gate for out-of-scope trust candidate", async () => {
  let runThreadCalled = false;
  const fakeSdk = {
    startThread: () => ({ id: "t1" }),
    runThread: async () => {
      runThreadCalled = true;
      return { outputText: "RECOVERY_STATUS: repaired\nSUMMARY: should not run" };
    }
  };
  const events: string[] = [];

  const result = await runRecoveryManager({
    runId: "run-1",
    task: "install missing tool",
    reason: "command not found: browse",
    spec,
    policy,
    skillLibrary: [makeSkill("unsafe-repair", "standard", "repair")],
    sdkClient: fakeSdk as any,
    maxAttempts: 2,
    trustScope: "certified-popular",
    riskyGateEnabled: true,
    askUserGate: async () => false,
    emitEvent: async (event) => {
      events.push(event.type);
    }
  });

  assert.equal(result.status, "need_user_gate");
  assert.equal(runThreadCalled, false);
  assert.equal(events.includes("recovery.started"), true);
  assert.equal(events.includes("recovery.candidate.selected"), true);
});

test("runRecoveryManager returns repaired when candidate passes smoke output contract", async () => {
  const fakeSdk = {
    startThread: () => ({ id: "t2" }),
    runThread: async () => ({
      outputText: "RECOVERY_STATUS: repaired\nSMOKE_TEST: which browse\nSMOKE_RESULT: pass\nSUMMARY: installed browse cli"
    })
  };
  const events: string[] = [];

  const result = await runRecoveryManager({
    runId: "run-2",
    task: "open https://example.com",
    reason: "command not found: browse",
    spec,
    policy,
    skillLibrary: [makeSkill("mcp-recovery", "certified", "repair")],
    sdkClient: fakeSdk as any,
    maxAttempts: 1,
    trustScope: "certified-popular",
    riskyGateEnabled: true,
    askUserGate: async () => true,
    emitEvent: async (event) => {
      events.push(event.type);
    }
  });

  assert.equal(result.status, "repaired");
  assert.equal(result.skillId, "mcp-recovery");
  assert.equal(result.summary.includes("installed browse cli"), true);
  assert.equal(events.includes("recovery.test.passed"), true);
  assert.equal(events.includes("recovery.finished"), true);
});

test("runRecoveryManager requests user gate for high-risk recovery even with trusted skill", async () => {
  let runThreadCalled = false;
  const fakeSdk = {
    startThread: () => ({ id: "t3" }),
    runThread: async () => {
      runThreadCalled = true;
      return { outputText: "RECOVERY_STATUS: repaired\nSUMMARY: should not run" };
    }
  };

  const result = await runRecoveryManager({
    runId: "run-3",
    task: "please do npm install -g @browserbasehq/browse-cli",
    reason: "need global install for browse cli",
    spec,
    policy,
    skillLibrary: [makeSkill("mcp-recovery", "certified", "repair")],
    sdkClient: fakeSdk as any,
    maxAttempts: 1,
    trustScope: "certified-popular",
    riskyGateEnabled: true,
    askUserGate: async () => false,
    emitEvent: async () => undefined
  });

  assert.equal(result.status, "need_user_gate");
  assert.equal(runThreadCalled, false);
});
