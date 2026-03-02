import path from "node:path";
import { Codex, Thread, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import type { AppConfig, RunEvent } from "../../types/contracts.js";

function nowIso(): string {
  return new Date().toISOString();
}

export type RunThreadArgs = {
  thread: Thread;
  input: string;
  onEvent?: (event: RunEvent) => void;
  emitDeltaEvents?: boolean;
  outputSchema?: unknown;
  signal?: AbortSignal;
};

export type RunThreadResult = {
  outputText: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  threadId: string | null;
};

export class CodexSdkRuntimeClient {
  private readonly codex: Codex;
  private readonly threadOptions: ThreadOptions;

  constructor(engine: AppConfig["engine"], overrideOptions?: Partial<ThreadOptions>) {
    const workingDirectory = path.resolve(overrideOptions?.workingDirectory ?? process.cwd());
    this.codex = new Codex();
    this.threadOptions = {
      model: engine.model,
      workingDirectory,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      ...overrideOptions
    };
  }

  startThread(): Thread {
    return this.codex.startThread(this.threadOptions);
  }

  resumeThread(id: string): Thread {
    return this.codex.resumeThread(id, this.threadOptions);
  }

  async runThread(args: RunThreadArgs): Promise<RunThreadResult> {
    const turnOptions: TurnOptions = {
      outputSchema: args.outputSchema,
      signal: args.signal
    };

    const turn = await args.thread.run(args.input, turnOptions);

    for (const item of turn.items) {
      if (item.type === "agent_message" && item.text) {
        if (args.emitDeltaEvents === false) {
          continue;
        }
        args.onEvent?.({ type: "engine.delta", chunk: item.text, ts: nowIso() });
        continue;
      }

      if (item.type === "command_execution") {
        if (item.aggregated_output) {
          args.onEvent?.({
            type: "runner.stdout",
            line: item.aggregated_output.slice(0, 2000),
            ts: nowIso()
          });
        }
        continue;
      }

      if (item.type === "file_change") {
        continue;
      }

      if (item.type === "mcp_tool_call") {
        args.onEvent?.({
          type: "tool.called",
          name: `${item.server}.${item.tool}`,
          args: item.arguments,
          ts: nowIso()
        });
        args.onEvent?.({
          type: "tool.result",
          name: `${item.server}.${item.tool}`,
          ok: item.status !== "failed",
          ts: nowIso()
        });
      }

      if (item.type === "error") {
        args.onEvent?.({ type: "run.error", message: item.message, ts: nowIso() });
      }
    }

    const usage = turn.usage
      ? {
          input_tokens: turn.usage.input_tokens,
          output_tokens: turn.usage.output_tokens,
          total_tokens: turn.usage.input_tokens + turn.usage.output_tokens
        }
      : undefined;

    return {
      outputText: turn.finalResponse || "",
      usage,
      threadId: args.thread.id
    };
  }
}
