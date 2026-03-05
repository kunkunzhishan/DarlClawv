import path from "node:path";
import type { AppConfig } from "../types/contracts.js";
import { fileExists, readText } from "../utils/fs.js";
import { parseYaml } from "../utils/yaml.js";
import type { ChannelConfig, ChannelConfigDocument, ChannelTriggerConfig } from "./types.js";

export type ChannelsConfigResult = {
  path: string;
  data: ChannelConfigDocument;
};

function toString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toBoolean(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeTrigger(raw: unknown): ChannelTriggerConfig | undefined {
  const trigger = toRecord(raw);
  const modeRaw = toString(trigger.mode);
  const mode =
    modeRaw === "direct" || modeRaw === "mention" || modeRaw === "prefix" || modeRaw === "mention-or-prefix"
      ? modeRaw
      : undefined;
  const prefix = toString(trigger.prefix);
  if (!mode && !prefix) {
    return undefined;
  }
  return {
    mode,
    prefix
  };
}

export function normalizeChannelsConfig(raw: unknown): ChannelConfigDocument {
  const doc = toRecord(raw);
  const channelsRaw = Array.isArray(doc.channels) ? doc.channels : [];
  const channels: ChannelConfig[] = [];
  for (const item of channelsRaw) {
    const entry = toRecord(item);
    const id = toString(entry.id);
    const kind = toString(entry.kind);
    const skillId = toString(entry.skill_id);
    if (!id || !kind || !skillId) {
      continue;
    }
    const channel: ChannelConfig = {
      id,
      kind,
      skill_id: skillId,
      enabled: toBoolean(entry.enabled, true),
      agent_id: toString(entry.agent_id),
      trigger: normalizeTrigger(entry.trigger),
      config: toRecord(entry.config)
    };
    channels.push(channel);
  }

  return {
    version: 1,
    channels
  };
}

async function resolveConfigPath(appConfig: AppConfig, controlPlaneRoot?: string): Promise<string> {
  const root = controlPlaneRoot ? path.resolve(controlPlaneRoot) : process.cwd();
  const explicit = appConfig.channels?.config_path
    ? path.resolve(root, appConfig.channels.config_path)
    : undefined;
  if (explicit && (await fileExists(explicit))) {
    return explicit;
  }
  const userPath = path.resolve(root, "user", "channels.yaml");
  if (await fileExists(userPath)) {
    return userPath;
  }
  return path.resolve(root, "src", "config", "channels.yaml");
}

export async function loadChannelsConfig(
  appConfig: AppConfig,
  controlPlaneRoot?: string
): Promise<ChannelsConfigResult> {
  const configPath = await resolveConfigPath(appConfig, controlPlaneRoot);
  if (!(await fileExists(configPath))) {
    return {
      path: configPath,
      data: { version: 1, channels: [] }
    };
  }
  const raw = await readText(configPath);
  const parsed = parseYaml<unknown>(raw, configPath);
  return {
    path: configPath,
    data: normalizeChannelsConfig(parsed)
  };
}
