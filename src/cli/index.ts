#!/usr/bin/env node
import { Command } from "commander";
import { runTask } from "../core/supervisor/index.js";
import {
  readRecentGlobalMemory,
  readRecentGroupVectorMemory,
  readRecentPersonalVectorMemory,
  readTemporaryContext,
  resolveMemoryPaths,
  resolveMemoryRuntimeOptions
} from "../core/memory/store.js";
import { getPendingPromotions, promoteCapability, rejectCapabilityPromotion } from "../core/skill-manager/promotion.js";
import { loadAgentSpec, listAgentSpecIds } from "../registry/agent-spec.js";
import { loadAppConfig } from "../registry/index.js";
import { getRunDetails, listRuns, toRunContext } from "../storage/index.js";
import { loadDotEnv } from "../utils/env.js";
import { ensureWebObservatory } from "../web/autostart.js";
import { startWebServer } from "../web/server.js";

loadDotEnv();

const program = new Command();

program.name("darlclawv").description("Control-plane shell around native Codex runtime").version("0.1.0");

program
  .command("run")
  .requiredOption("--task <text>", "task text")
  .option("--agent <id>", "optional preferred agent id")
  .option("--workspace <path>", "task workspace path (default: current working directory)")
  .option("--run-mode <mode>", "permission mode: managed|direct", "managed")
  .option("--admin-cap <profile>", "admin max grant profile: safe|workspace|full")
  .option("--json", "print structured JSON output instead of plain result text")
  .action(async (opts) => {
    const runMode = String(opts.runMode || "managed").toLowerCase();
    if (!["managed", "direct"].includes(runMode)) {
      console.error(`invalid run mode: ${opts.runMode}`);
      process.exitCode = 1;
      return;
    }

    const adminCap = opts.adminCap ? String(opts.adminCap).toLowerCase() : undefined;
    if (adminCap && !["safe", "workspace", "full"].includes(adminCap)) {
      console.error(`invalid admin cap: ${opts.adminCap}`);
      process.exitCode = 1;
      return;
    }

    const appConfig = await loadAppConfig();
    if (appConfig.web.autostart) {
      const observatory = await ensureWebObservatory(appConfig.web);
      const stateText = observatory.started ? "started" : "ready";
      console.error(`[observatory:${stateText}] ${observatory.url}`);
    }

    let streamed = false;
    const result = await runTask({
      agentId: opts.agent,
      task: opts.task,
      taskWorkspace: opts.workspace,
      runMode: runMode as "managed" | "direct",
      adminCap: adminCap as "safe" | "workspace" | "full" | undefined
    }, opts.json
      ? undefined
      : {
          onEvent: (event) => {
            if (event.type === "engine.delta") {
              process.stdout.write(event.chunk);
              streamed = true;
            }
          }
        });

    if (streamed) {
      process.stdout.write("\n");
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            runId: result.runId,
            status: result.result.status,
            output: result.result.outputText,
            error: result.result.error,
            failureKind: result.result.failureKind,
            exitCode: result.result.exitCode,
            usage: result.result.usage
          },
          null,
          2
        )
      );
    } else if (!streamed && result.result.outputText?.trim()) {
      console.log(result.result.outputText);
    } else if (!streamed) {
      console.log(`[runId=${result.runId}] status=${result.result.status}`);
    }

    if (result.result.status === "failed") {
      process.exitCode = 1;
      if (result.result.error) {
        console.error(result.result.error);
      }
    }
  });

const agents = program.command("agents").description("Agent spec and memory commands");

agents.command("list").action(async () => {
  const appConfig = await loadAppConfig();
  const ids = await listAgentSpecIds(appConfig.agent.config_root);
  if (ids.length === 0) {
    console.log("no agents found");
    return;
  }
  for (const id of ids) {
    console.log(id);
  }
});

agents
  .command("show")
  .requiredOption("--agent <id>", "agent id")
  .option("--json", "print JSON output")
  .action(async (opts) => {
    const appConfig = await loadAppConfig();
    const spec = await loadAgentSpec(opts.agent, appConfig.agent.config_root);
    if (opts.json) {
      console.log(JSON.stringify(spec, null, 2));
      return;
    }
    console.log(`# ${spec.id}`);
    if (spec.summary) {
      console.log(spec.summary);
    }
    console.log(`path: ${spec.path}`);
    console.log(`skills: ${spec.skillWhitelist.join(", ") || "(none)"}`);
  });

agents
  .command("memory")
  .requiredOption("--agent <id>", "agent id")
  .option("--scope <scope>", "global|temporary|personal|group", "temporary")
  .option("--limit <number>", "number of entries", "10")
  .option("--json", "print JSON output")
  .action(async (opts) => {
    const appConfig = await loadAppConfig();
    const paths = resolveMemoryPaths(appConfig, opts.agent);
    const memoryOptions = resolveMemoryRuntimeOptions(appConfig);
    const limit = Number.parseInt(opts.limit, 10);
    const maxItems = Number.isFinite(limit) && limit > 0 ? limit : 10;

    const scope = String(opts.scope || "temporary").toLowerCase();
    if (!["global", "temporary", "personal", "group"].includes(scope)) {
      console.error(`unsupported scope: ${opts.scope}`);
      process.exitCode = 1;
      return;
    }

    const entries = scope === "global"
        ? await readRecentGlobalMemory(paths, maxItems)
        : scope === "temporary"
          ? await readTemporaryContext(paths, maxItems)
          : scope === "personal"
            ? await readRecentPersonalVectorMemory({ paths, limit: maxItems, options: memoryOptions })
            : await readRecentGroupVectorMemory({ paths, limit: maxItems, options: memoryOptions });

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log("no memory entries");
      return;
    }

    for (const entry of entries) {
      console.log(JSON.stringify(entry));
    }
  });

const runs = program.command("runs").description("Run history commands");

program
  .command("web")
  .option("--port <number>", "start port (auto-increment on conflict)", "4789")
  .option("--host <host>", "bind host (default: 127.0.0.1)", "127.0.0.1")
  .action(async (opts) => {
    const port = Number.parseInt(String(opts.port), 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error(`invalid port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }
    await startWebServer(port, String(opts.host || "127.0.0.1"));
  });

runs.command("list").action(async () => {
  const items = await listRuns();
  for (const item of items) {
    console.log(`${item.runId}\t${item.status}\t${item.startedAt}\t${item.request.agentId || "auto"}`);
  }
});

runs
  .command("show")
  .argument("<runId>", "run id")
  .option("--replay", "replay events")
  .action(async (runId, opts) => {
    const details = await getRunDetails(runId);
    if (!details) {
      console.error(`run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({ summary: details.summary, result: details.result }, null, 2));
    if (opts.replay) {
      for (const event of details.events) {
        console.log(JSON.stringify(event));
      }
    }
  });

const capabilities = program.command("capabilities").description("Capability promotion commands");

capabilities
  .command("pending")
  .requiredOption("--run <runId>", "run id")
  .option("--json", "print JSON output")
  .action(async (opts) => {
    const ctx = toRunContext(opts.run);
    const pending = await getPendingPromotions(ctx);
    if (opts.json) {
      console.log(JSON.stringify(pending, null, 2));
      return;
    }
    if (pending.length === 0) {
      console.log("no pending promotions");
      return;
    }
    for (const item of pending) {
      console.log(`${item.capabilityId}\t${item.sourcePath}\t${item.requestedAt}`);
    }
  });

capabilities
  .command("promote")
  .requiredOption("--run <runId>", "run id")
  .requiredOption("--capability <id>", "capability id")
  .action(async (opts) => {
    const ctx = toRunContext(opts.run);
    const result = await promoteCapability({ ctx, capabilityId: opts.capability });
    console.log(`promoted ${opts.capability} -> ${result.targetPath}`);
  });

capabilities
  .command("reject")
  .requiredOption("--run <runId>", "run id")
  .requiredOption("--capability <id>", "capability id")
  .action(async (opts) => {
    const ctx = toRunContext(opts.run);
    await rejectCapabilityPromotion({ ctx, capabilityId: opts.capability });
    console.log(`rejected pending promotion for ${opts.capability}`);
  });

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
