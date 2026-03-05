import path from "node:path";
import { Codex, Thread, type CodexOptions, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import type { AppConfig, RunEvent } from "../../types/contracts.js";

function nowIso(): string {
  return new Date().toISOString();
}

function inheritProcessEnvWithCodexHome(codexHome?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  if (codexHome) {
    env.CODEX_HOME = codexHome;
  }
  // Codex CLI auth uses CODEX_API_KEY; fall back to OPENAI_API_KEY for compatibility.
  if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) {
    env.CODEX_API_KEY = env.OPENAI_API_KEY;
  }
  return env;
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
    const codexHome = engine.codex_home ? path.resolve(engine.codex_home) : undefined;
    const codexOptions: CodexOptions | undefined = codexHome
      ? { env: inheritProcessEnvWithCodexHome(codexHome) }
      : undefined;
    this.codex = new Codex(codexOptions);
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

    const streamed = await args.thread.runStreamed(args.input, turnOptions);
    const latestItems = new Map<string, unknown>();
    const streamErrors: string[] = [];
    let turnFailedMessage: string | undefined;
    let usage: RunThreadResult["usage"] | undefined;

    try {
      for await (const event of streamed.events) {
        if (event.type === "error") {
          streamErrors.push(event.message);
          args.onEvent?.({ type: "run.error", message: event.message, ts: nowIso() });
          continue;
        }
        if (event.type === "turn.failed") {
          turnFailedMessage = event.error.message;
          continue;
        }
        if (event.type === "turn.completed") {
          usage = {
            input_tokens: event.usage.input_tokens,
            output_tokens: event.usage.output_tokens,
            total_tokens: event.usage.input_tokens + event.usage.output_tokens
          };
          continue;
        }
        if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
          latestItems.set(event.item.id, event.item);
        }
      }
    } catch (error) {
      if (streamErrors.length > 0) {
        throw new Error(streamErrors[streamErrors.length - 1]);
      }
      throw error;
    }

    if (turnFailedMessage) {
      throw new Error(turnFailedMessage);
    }

    const agentMessages: string[] = [];
    const reasoningMessages: string[] = [];
    let hasExecutionSignals = false;

    for (const itemUnknown of latestItems.values()) {
      const item = itemUnknown as {
        type?: string;
        text?: string;
        aggregated_output?: string;
        exit_code?: number;
        server?: string;
        tool?: string;
        arguments?: unknown;
        status?: string;
        message?: string;
      };
      if (item.type === "agent_message" && item.text) {
        agentMessages.push(item.text);
        if (args.emitDeltaEvents !== false) {
          args.onEvent?.({ type: "engine.delta", chunk: item.text, ts: nowIso() });
        }
        continue;
      }
      if (item.type === "reasoning" && item.text) {
        reasoningMessages.push(item.text);
        continue;
      }
      if (item.type === "command_execution") {
        hasExecutionSignals = true;
        if (item.aggregated_output) {
          args.onEvent?.({
            type: "runner.stdout",
            line: item.aggregated_output.slice(0, 2000),
            ts: nowIso()
          });
        }
        if (typeof item.exit_code === "number") {
          args.onEvent?.({
            type: "runner.exited",
            code: item.exit_code,
            ts: nowIso()
          });
        }
        continue;
      }
      if (item.type === "mcp_tool_call") {
        hasExecutionSignals = true;
        const server = item.server || "mcp";
        const tool = item.tool || "unknown";
        args.onEvent?.({
          type: "tool.called",
          name: `${server}.${tool}`,
          args: item.arguments,
          ts: nowIso()
        });
        args.onEvent?.({
          type: "tool.result",
          name: `${server}.${tool}`,
          ok: item.status !== "failed",
          ts: nowIso()
        });
        continue;
      }
      if (item.type === "error" && item.message) {
        hasExecutionSignals = true;
        args.onEvent?.({ type: "run.error", message: item.message, ts: nowIso() });
      }
    }

    const outputText = agentMessages.join("\n").trim() || reasoningMessages.join("\n").trim();
    if (!outputText && streamErrors.length > 0 && !hasExecutionSignals) {
      throw new Error(streamErrors[streamErrors.length - 1]);
    }

    return {
      outputText,
      usage,
      threadId: args.thread.id
    };
  }
}
