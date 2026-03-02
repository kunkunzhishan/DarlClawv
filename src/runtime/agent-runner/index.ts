#!/usr/bin/env node
// Deprecated path: retained for backward compatibility while runtime transitions to Codex SDK threads.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { evaluatePolicy } from "../../core/policy-engine/index.js";
import { compilePrompt, pickPreferredAgent } from "../../core/prompt-compiler/index.js";
import { loadAgents, loadAppConfig, loadPolicies, loadSkills } from "../../registry/index.js";
import { ensureDir, readText } from "../../utils/fs.js";
import type { EngineRunResult, FailureKind, RunEvent } from "../../types/contracts.js";
import type { RunnerMessage, RunnerRequest } from "./protocol.js";

function nowIso(): string {
  return new Date().toISOString();
}

function emit(message: RunnerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitEvent(event: RunEvent): void {
  emit({ kind: "event", event });
}

function emitResult(result: EngineRunResult): void {
  emit({ kind: "result", result });
}

async function readRequest(): Promise<RunnerRequest> {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk.toString("utf8");
  }

  const parsed = JSON.parse(body) as RunnerRequest;
  if (!parsed?.runId || !parsed?.task) {
    throw new Error("Invalid runner request");
  }
  return parsed;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function candidateCommands(configured: string): string[] {
  const defaults = ["codex"];
  if (process.platform === "darwin") {
    defaults.push("/Applications/Codex.app/Contents/Resources/codex");
  }
  return unique([process.env.MYDARL_CODEX_COMMAND || configured, ...defaults]);
}

function isEnoentError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("enoent") || (lower.includes("spawn") && lower.includes("not found"));
}

function isAuthMissingError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("401") &&
    (lower.includes("unauthorized") ||
      lower.includes("未提供令牌") ||
      lower.includes("missing token") ||
      lower.includes("not provided token"))
  );
}

function classifyFailure(errorText: string): FailureKind {
  const lower = errorText.toLowerCase();
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("token") ||
    lower.includes("令牌")
  ) {
    return "auth";
  }
  if (
    lower.includes("502") ||
    lower.includes("bad gateway") ||
    lower.includes("reconnecting") ||
    lower.includes("stream disconnected") ||
    lower.includes("timeout") ||
    lower.includes("econn") ||
    lower.includes("enotfound") ||
    lower.includes("network")
  ) {
    return "network";
  }
  if (lower.includes("mcp") || lower.includes("tool") || lower.includes("server")) {
    return "tool";
  }
  if (lower.includes("output") || lower.includes("json") || lower.includes("schema") || lower.includes("model")) {
    return "model";
  }
  return "unknown";
}

function toErrorText(args: {
  stderr: string;
  eventErrors: string[];
  recentStdout: string[];
  lastCommandFailure?: string;
  didTimeout: boolean;
  timeoutMs: number;
  exitCode: number;
}): string {
  const { stderr, eventErrors, recentStdout, lastCommandFailure, didTimeout, timeoutMs, exitCode } = args;
  const cleanEvents = eventErrors.map((line) => line.trim()).filter(Boolean);
  if (cleanEvents.length > 0) {
    return cleanEvents.slice(-8).join("\n").slice(0, 4000);
  }

  if (lastCommandFailure) {
    return lastCommandFailure.slice(0, 4000);
  }

  const stderrLines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (stderrLines.length > 0) {
    return stderrLines.slice(-20).join("\n").slice(0, 4000);
  }

  if (didTimeout) {
    const tail = recentStdout.slice(-3).join(" | ");
    return `timed out after ${timeoutMs}ms before final response (exit=${exitCode})${tail ? `; last events: ${tail}` : ""}`;
  }

  if (recentStdout.length > 0) {
    const tail = recentStdout.slice(-4).join(" | ");
    return `process exited with code ${exitCode} without final response; last events: ${tail}`;
  }

  return `process exited with code ${exitCode} and no diagnostics`;
}

function flushChunkLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const merged = buffer + chunk;
  const parts = merged.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  const lines = parts.map((line) => line.trim()).filter(Boolean);
  return { lines, rest };
}

async function loginWithApiKey(command: string, codexHome?: string): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const env = { ...process.env };
    if (codexHome) {
      env.CODEX_HOME = codexHome;
    }

    const proc = spawn(command, ["login", "--with-api-key"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "ignore", "ignore"]
    });

    let done = false;
    const finish = (ok: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      resolve(ok);
    };

    proc.on("error", () => finish(false));
    proc.stdin.write(`${apiKey}\n`, "utf8");
    proc.stdin.end();
    proc.on("close", (code) => finish(code === 0));
  });
}

async function runWithCommand(args: {
  command: string;
  model: string;
  cliArgs: string[];
  timeoutMs: number;
  promptText: string;
  codexHome?: string;
}): Promise<EngineRunResult> {
  const outputFile = path.join(os.tmpdir(), `mydarl-codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const commandArgs = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    process.cwd(),
    "--output-last-message",
    outputFile,
    "-m",
    args.model,
    ...args.cliArgs,
    "-"
  ];

  return await new Promise<EngineRunResult>((resolve) => {
    let settled = false;
    let didTimeout = false;
    const finish = (result: EngineRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const env = { ...process.env };
    if (args.codexHome) {
      env.CODEX_HOME = args.codexHome;
    }

    const proc = spawn(args.command, commandArgs, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdoutRemainder = "";
    let stderrRemainder = "";
    const stderrChunks: string[] = [];
    const eventErrors: string[] = [];
    const recentStdout: string[] = [];
    let lastCommandFailure: string | undefined;

    proc.on("error", (error: NodeJS.ErrnoException) => {
      const errorText = error.message || `${error.code || "spawn_error"}`;
      finish({
        status: "failed",
        outputText: "",
        error: `Codex CLI error: ${errorText}`,
        exitCode: 127,
        failureKind: classifyFailure(errorText)
      });
    });

    proc.stdin.write(args.promptText, "utf8");
    proc.stdin.end();

    proc.stdout.on("data", (chunk: Buffer) => {
      const split = flushChunkLines(stdoutRemainder, chunk.toString("utf8"));
      stdoutRemainder = split.rest;

      for (const line of split.lines) {
        emitEvent({ type: "runner.stdout", line: line.slice(0, 2000), ts: nowIso() });
        recentStdout.push(line.slice(0, 300));
        if (recentStdout.length > 20) {
          recentStdout.shift();
        }
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (typeof parsed?.delta === "string" && parsed.delta.length > 0) {
          emitEvent({ type: "engine.delta", chunk: parsed.delta, ts: nowIso() });
        }

        if (parsed?.type === "error" && typeof parsed?.message === "string") {
          eventErrors.push(parsed.message);
        }

        if (
          parsed?.type === "item.completed" &&
          parsed?.item?.type === "command_execution" &&
          parsed?.item?.status === "failed"
        ) {
          const commandRaw = String(parsed.item.command ?? "").replace(/\s+/g, " ").trim();
          const command = commandRaw.length > 140 ? `${commandRaw.slice(0, 140)}...` : commandRaw;
          const outputRaw = String(parsed.item.aggregated_output ?? "").replace(/\s+/g, " ").trim();
          const output = outputRaw.length > 240 ? `${outputRaw.slice(0, 240)}...` : outputRaw;
          lastCommandFailure = output ? `command failed: ${command}; output: ${output}` : `command failed: ${command}`;
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);

      const split = flushChunkLines(stderrRemainder, text);
      stderrRemainder = split.rest;
      for (const line of split.lines) {
        emitEvent({ type: "runner.stderr", line: line.slice(0, 2000), ts: nowIso() });
      }
    });

    const timer = setTimeout(() => {
      didTimeout = true;
      proc.kill("SIGTERM");
    }, args.timeoutMs);

    proc.on("close", async (code) => {
      clearTimeout(timer);
      const normalizedCode = code ?? -1;
      emitEvent({ type: "runner.exited", code: normalizedCode, ts: nowIso() });

      if (stdoutRemainder.trim()) {
        emitEvent({ type: "runner.stdout", line: stdoutRemainder.trim().slice(0, 2000), ts: nowIso() });
      }
      if (stderrRemainder.trim()) {
        emitEvent({ type: "runner.stderr", line: stderrRemainder.trim().slice(0, 2000), ts: nowIso() });
      }

      if (settled) {
        return;
      }

      if (normalizedCode !== 0) {
        const errorText = toErrorText({
          stderr: stderrChunks.join(""),
          eventErrors,
          recentStdout,
          lastCommandFailure,
          didTimeout,
          timeoutMs: args.timeoutMs,
          exitCode: normalizedCode
        });
        finish({
          status: "failed",
          outputText: "",
          error: `Codex CLI error: ${errorText}`,
          exitCode: normalizedCode,
          failureKind: classifyFailure(errorText)
        });
        return;
      }

      let outputText = "";
      try {
        outputText = (await readText(outputFile)).trim();
      } catch {
        outputText = "";
      }

      if (!outputText && eventErrors.length > 0) {
        const errorText = toErrorText({
          stderr: stderrChunks.join(""),
          eventErrors,
          recentStdout,
          lastCommandFailure,
          didTimeout,
          timeoutMs: args.timeoutMs,
          exitCode: normalizedCode
        });
        finish({
          status: "failed",
          outputText: "",
          error: `Codex CLI error: ${errorText}`,
          exitCode: normalizedCode,
          failureKind: classifyFailure(errorText)
        });
        return;
      }

      if (!outputText) {
        finish({
          status: "failed",
          outputText: "",
          error: "Codex CLI error: model-output-empty",
          exitCode: normalizedCode,
          failureKind: "model"
        });
        return;
      }

      finish({
        status: "ok",
        outputText,
        exitCode: normalizedCode
      });
    });
  });
}

async function executeCodex(args: {
  configuredCommand: string;
  model: string;
  cliArgs: string[];
  timeoutMs: number;
  promptText: string;
  codexHome?: string;
}): Promise<EngineRunResult> {
  const candidates = candidateCommands(args.configuredCommand);
  let lastFailure: EngineRunResult | null = null;

  for (const command of candidates) {
    let result = await runWithCommand({
      command,
      model: args.model,
      cliArgs: args.cliArgs,
      timeoutMs: args.timeoutMs,
      promptText: args.promptText,
      codexHome: args.codexHome
    });

    if (result.status === "ok") {
      return result;
    }

    if (isAuthMissingError(result.error ?? "")) {
      const reloginOk = await loginWithApiKey(command, args.codexHome);
      if (reloginOk) {
        result = await runWithCommand({
          command,
          model: args.model,
          cliArgs: args.cliArgs,
          timeoutMs: args.timeoutMs,
          promptText: args.promptText,
          codexHome: args.codexHome
        });
        if (result.status === "ok") {
          return result;
        }
      }
    }

    lastFailure = result;
    if (!isEnoentError(result.error ?? "")) {
      return result;
    }
  }

  return (
    lastFailure ?? {
      status: "failed",
      outputText: "",
      error:
        "Codex CLI error: command not found. Set MYDARL_CODEX_COMMAND to your codex executable path, e.g. /Applications/Codex.app/Contents/Resources/codex",
      exitCode: 127,
      failureKind: "unknown"
    }
  );
}

async function main(): Promise<void> {
  try {
    const request = await readRequest();
    emitEvent({ type: "runner.started", pid: process.pid, ts: nowIso() });

    const appConfig = await loadAppConfig();
    const [agentsMap, skillsMap, policiesMap] = await Promise.all([loadAgents(), loadSkills(), loadPolicies()]);

    const agents = [...agentsMap.values()];
    const skills = [...skillsMap.values()];

    const defaultAgentId = appConfig.agent?.default_id || appConfig.default_agent || agents[0]?.id || "default";
    const preferredAgent = pickPreferredAgent(agents, defaultAgentId, request.agentId);
    const policyId = request.policyId || appConfig.default_policy;
    const policy = policiesMap.get(policyId);
    if (!policy) {
      const errorText = `Policy not found: ${policyId}`;
      emitEvent({ type: "run.error", message: errorText, ts: nowIso() });
      emitResult({ status: "failed", outputText: "", error: errorText, failureKind: "unknown" });
      process.exit(1);
      return;
    }

    const decision = evaluatePolicy(request.task, policy);
    if (!decision.ok) {
      const errorText = `Policy denied request: ${decision.reasons.join("; ")}`;
      emitEvent({ type: "run.error", message: errorText, ts: nowIso() });
      emitResult({ status: "failed", outputText: "", error: errorText, failureKind: "tool" });
      process.exit(1);
      return;
    }

    if (decision.confirmations.length > 0 && !request.confirm) {
      const errorText = `Policy requires explicit confirmation for patterns: ${decision.confirmations.join(", ")}. Re-run with --confirm.`;
      emitEvent({ type: "run.error", message: errorText, ts: nowIso() });
      emitResult({ status: "failed", outputText: "", error: errorText, failureKind: "tool" });
      process.exit(1);
      return;
    }

    const prompt = compilePrompt({
      task: request.task,
      policy,
      preferredAgent,
      agentLibrary: agents,
      skillLibrary: skills
    });

    emitEvent({ type: "prompt.compiled", size: prompt.size, ts: nowIso() });

    const codexHome = process.env.MYDARL_CODEX_HOME?.trim();
    if (codexHome) {
      await ensureDir(codexHome);
    }

    const result = await executeCodex({
      configuredCommand: appConfig.engine.cli_command,
      model: appConfig.engine.model,
      cliArgs: appConfig.engine.cli_args,
      timeoutMs: appConfig.engine.timeout_ms,
      promptText: prompt.fullText,
      codexHome: codexHome || undefined
    });

    if (result.status === "failed" && result.error) {
      emitEvent({ type: "run.error", message: result.error, ts: nowIso() });
    }

    emitResult(result);
    process.exit(result.status === "ok" ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitEvent({ type: "run.error", message, ts: nowIso() });
    emitResult({
      status: "failed",
      outputText: "",
      error: message,
      failureKind: classifyFailure(message)
    });
    process.exit(1);
  }
}

void main();
