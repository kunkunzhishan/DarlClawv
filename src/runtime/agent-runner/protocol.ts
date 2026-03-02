// Deprecated protocol: retained for compatibility with legacy runner implementation.
import type { EngineRunResult, RunEvent } from "../../types/contracts.js";

export type RunnerRequest = {
  runId: string;
  task: string;
  agentId?: string;
  policyId?: string;
  confirm?: boolean;
};

export type RunnerMessage =
  | {
      kind: "event";
      event: RunEvent;
    }
  | {
      kind: "result";
      result: EngineRunResult;
    };
