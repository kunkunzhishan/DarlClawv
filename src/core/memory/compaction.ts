import type { AppConfig, EngineRunResult } from "../../types/contracts.js";

export function shouldRunCompaction(args: {
  appConfig: AppConfig;
  result: EngineRunResult;
}): boolean {
  const trigger = args.appConfig.memory.compaction.trigger;
  if (trigger === "on_task_finished") {
    return true;
  }

  const totalTokens = args.result.usage?.total_tokens ?? 0;
  return totalTokens >= args.appConfig.memory.compaction.token_threshold;
}
