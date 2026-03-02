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
  fileChangeGuard?: {
    role: string;
    allowedWriteRoots: string[];
    forbiddenWriteRoots?: string[];
    forbiddenWriteRootExceptions?: string[];
    addOnlyWriteRoots?: string[];
  };
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

function isPathInsideRoot(candidateAbs: string, rootAbs: string): boolean {
  const rel = path.relative(rootAbs, candidateAbs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveCandidatePath(candidatePath: string, workingDirectory: string): string {
  return path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workingDirectory, candidatePath);
}

export function isPathInsideAnyRoot(args: {
  candidatePath: string;
  workingDirectory: string;
  roots: string[];
}): boolean {
  const candidateAbs = resolveCandidatePath(args.candidatePath, args.workingDirectory);
  return args.roots.some((root) => isPathInsideRoot(candidateAbs, path.resolve(root)));
}

export function violatesAddOnlyRoots(args: {
  changeKind: "add" | "delete" | "update";
  candidatePath: string;
  workingDirectory: string;
  addOnlyRoots: string[];
}): boolean {
  return (
    args.changeKind !== "add" &&
    isPathInsideAnyRoot({
      candidatePath: args.candidatePath,
      workingDirectory: args.workingDirectory,
      roots: args.addOnlyRoots
    })
  );
}

export function isPathAllowedByRoots(args: {
  candidatePath: string;
  workingDirectory: string;
  allowedWriteRoots: string[];
}): boolean {
  const candidateAbs = resolveCandidatePath(args.candidatePath, args.workingDirectory);
  return args.allowedWriteRoots.some((root) => isPathInsideRoot(candidateAbs, path.resolve(root)));
}

export function isPathBlockedByRoots(args: {
  candidatePath: string;
  workingDirectory: string;
  forbiddenRoots: string[];
}): boolean {
  const candidateAbs = resolveCandidatePath(args.candidatePath, args.workingDirectory);
  return args.forbiddenRoots.some((root) => isPathInsideRoot(candidateAbs, path.resolve(root)));
}

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
        if (args.fileChangeGuard) {
          const workingDirectory = this.threadOptions.workingDirectory ?? process.cwd();
          const exceptionRoots = args.fileChangeGuard?.forbiddenWriteRootExceptions ?? [];
          const blocked = item.changes
            .filter((change) =>
              isPathBlockedByRoots({
                candidatePath: change.path,
                workingDirectory,
                forbiddenRoots: args.fileChangeGuard?.forbiddenWriteRoots ?? []
              }) &&
              !isPathInsideAnyRoot({
                candidatePath: change.path,
                workingDirectory,
                roots: exceptionRoots
              })
            )
            .map((change) => change.path);

          if (blocked.length > 0) {
            throw new Error(
              `File change blocked by forbidden roots for role=${args.fileChangeGuard.role}: ${blocked.join(", ")}`
            );
          }

          const violations = item.changes
            .filter((change) =>
              !isPathAllowedByRoots({
                candidatePath: change.path,
                workingDirectory,
                allowedWriteRoots: args.fileChangeGuard?.allowedWriteRoots ?? []
              })
            )
            .map((change) => change.path);

          if (violations.length > 0) {
            throw new Error(
              `File change outside allowed roots for role=${args.fileChangeGuard.role}: ${violations.join(", ")}`
            );
          }

          const addOnlyViolations = item.changes
            .filter((change) =>
              violatesAddOnlyRoots({
                changeKind: change.kind,
                candidatePath: change.path,
                workingDirectory,
                addOnlyRoots: args.fileChangeGuard?.addOnlyWriteRoots ?? []
              })
            )
            .map((change) => `${change.kind}:${change.path}`);

          if (addOnlyViolations.length > 0) {
            throw new Error(
              `File change violates add-only roots for role=${args.fileChangeGuard.role}: ${addOnlyViolations.join(", ")}`
            );
          }
        }
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
