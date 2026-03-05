import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAppConfig, loadSkills } from "../registry/index.js";
import { loadChannelsConfig } from "./config.js";
import { registerChannel, getChannelFactory } from "./registry.js";
import { openChannelStore } from "./store.js";
import { createChannelRouter } from "./router.js";
import { startChannelScheduler } from "./scheduler.js";
import type { ChannelAdapter, ChannelConfig, ChannelLogger } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function inferControlPlaneRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return process.cwd();
}

function makeLogger(prefix: string): ChannelLogger {
  return {
    info: (message) => console.log(`[${prefix}] ${message}`),
    warn: (message) => console.warn(`[${prefix}] ${message}`),
    error: (message) => console.error(`[${prefix}] ${message}`)
  };
}

type ChannelHub = {
  stop: () => Promise<void>;
};

export async function runChannelHub(args?: { controlPlaneRoot?: string }): Promise<ChannelHub> {
  const controlPlaneRoot = path.resolve(args?.controlPlaneRoot || inferControlPlaneRoot());
  const configRoot = path.join(controlPlaneRoot, "src", "config");
  const appConfig = await loadAppConfig(configRoot);
  if (!appConfig.channels.enabled) {
    throw new Error("channels are disabled in app config");
  }

  const logger = makeLogger("channels");
  const channelsConfig = await loadChannelsConfig(appConfig, controlPlaneRoot);
  const skills = await loadSkills(configRoot);
  const store = await openChannelStore(path.resolve(controlPlaneRoot, appConfig.channels.state_db_path));
  const { runTask } = await import("../core/supervisor/index.js");

  const channels = new Map<string, ChannelConfig>();
  const adapters = new Map<string, ChannelAdapter>();
  const moduleCache = new Set<string>();

  for (const channel of channelsConfig.data.channels) {
    if (channel.enabled === false) {
      continue;
    }
    const skill = skills.get(channel.skill_id);
    if (!skill) {
      logger.warn(`channel ${channel.id} missing skill ${channel.skill_id}`);
      continue;
    }

    const requiresEnv = skill.meta.channel?.requires_env ?? [];
    const missingEnv = requiresEnv.filter((name) => !process.env[name]);
    if (missingEnv.length > 0) {
      logger.warn(`channel ${channel.id} missing env: ${missingEnv.join(", ")}`);
      continue;
    }

    const entrypoint = skill.meta.channel?.entrypoint ?? skill.package?.entrypoint;
    if (!entrypoint) {
      logger.warn(`channel ${channel.id} missing entrypoint`);
      continue;
    }

    const entryPath = path.isAbsolute(entrypoint)
      ? entrypoint
      : path.resolve(skill.path, entrypoint);
    const entryUrl = pathToFileURL(entryPath).href;
    if (!moduleCache.has(entryUrl)) {
      try {
        const mod = await import(entryUrl);
        if (typeof mod.register === "function") {
          mod.register({ registerChannel });
        }
        const factory = mod.createChannelAdapter || mod.createAdapter || mod.default;
        if (typeof factory === "function") {
          registerChannel(channel.kind, factory);
        }
        moduleCache.add(entryUrl);
      } catch (error) {
        logger.error(`failed to load channel module ${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    const factory = getChannelFactory(channel.kind);
    if (!factory) {
      logger.warn(`channel ${channel.id} has no factory for kind=${channel.kind}`);
      continue;
    }
    const channelLogger = makeLogger(`channel:${channel.id}`);
    const adapter = await factory({ channelId: channel.id, config: channel, logger: channelLogger });
    channels.set(channel.id, channel);
    adapters.set(channel.id, adapter);
    store.upsertChannel({ id: channel.id, kind: channel.kind, enabled: true });
  }

  const router = createChannelRouter({
    store,
    adapters,
    channels,
    runTask,
    controlPlaneRoot,
    defaultAgentId: appConfig.agent.default_id || "default",
    maxInflight: appConfig.channels.max_inflight,
    logger
  });

  for (const [channelId, adapter] of adapters.entries()) {
    const channel = channels.get(channelId);
    if (!channel) {
      continue;
    }
    await adapter.start({
      onMessage: async (message) => {
        await router.handleMessage(message);
      }
    });
    logger.info(`channel ${channelId} started at ${nowIso()}`);
  }

  const scheduler = startChannelScheduler({
    store,
    adapters,
    channels,
    runTask,
    controlPlaneRoot,
    intervalMs: appConfig.channels.poll_interval_ms,
    logger
  });

  return {
    stop: async () => {
      scheduler.stop();
      for (const adapter of adapters.values()) {
        await adapter.stop();
      }
      store.close();
    }
  };
}
