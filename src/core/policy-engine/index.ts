import type { Policy } from "../../types/contracts.js";

export type PolicyDecision = {
  ok: boolean;
  reasons: string[];
  confirmations: string[];
};

function matchAny(task: string, rules: string[]): string[] {
  const lowerTask = task.toLowerCase();
  return rules.filter((rule) => lowerTask.includes(rule.toLowerCase()));
}

export function evaluatePolicy(task: string, policy: Policy): PolicyDecision {
  const reasons: string[] = [];
  const confirmations: string[] = [];

  const denied = matchAny(task, policy.shell.deny);
  if (denied.length > 0) {
    reasons.push(`Matched denied command patterns: ${denied.join(", ")}`);
  }

  const needsConfirm = matchAny(task, policy.shell.confirm_on);
  if (needsConfirm.length > 0) {
    confirmations.push(...needsConfirm);
  }

  if (!policy.network.enabled && task.toLowerCase().includes("http")) {
    reasons.push("Task appears to require network while network is disabled by policy.");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    confirmations
  };
}
