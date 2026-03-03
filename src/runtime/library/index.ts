import path from "node:path";
import { fileExists, readText, writeText, ensureDir } from "../../utils/fs.js";
import type { RuntimeLibraryPaths } from "../../types/contracts.js";

export type RuntimeCapabilityIndex = {
  updatedAt: string;
  capabilities: Array<{
    id: string;
    path: string;
    kind: "script" | "skill" | "mcp" | "hybrid";
    status: "draft" | "tested" | "active";
    lastUsedAt: string;
  }>;
};

export type RuntimeCapabilityRecord = RuntimeCapabilityIndex["capabilities"][number];

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultRuntimeLibraryPaths(root = path.resolve(".darlclawv-runtime/staging")): RuntimeLibraryPaths {
  return {
    root,
    scriptsDir: path.join(root, "scripts"),
    mcpDir: path.join(root, "mcp"),
    testsDir: path.join(root, "tests"),
    logsDir: path.join(root, "logs"),
    indexPath: path.join(root, "index.json")
  };
}

export async function ensureRuntimeLibrary(root?: string): Promise<RuntimeLibraryPaths> {
  const paths = defaultRuntimeLibraryPaths(root);
  await Promise.all([
    ensureDir(paths.root),
    ensureDir(paths.scriptsDir),
    ensureDir(paths.mcpDir),
    ensureDir(paths.testsDir),
    ensureDir(paths.logsDir)
  ]);

  if (!(await fileExists(paths.indexPath))) {
    const initial: RuntimeCapabilityIndex = { updatedAt: nowIso(), capabilities: [] };
    await writeText(paths.indexPath, JSON.stringify(initial, null, 2));
  }

  return paths;
}

export async function readRuntimeCapabilityIndex(paths: RuntimeLibraryPaths): Promise<RuntimeCapabilityIndex> {
  if (!(await fileExists(paths.indexPath))) {
    return { updatedAt: nowIso(), capabilities: [] };
  }

  try {
    return JSON.parse(await readText(paths.indexPath)) as RuntimeCapabilityIndex;
  } catch {
    return { updatedAt: nowIso(), capabilities: [] };
  }
}

export async function writeRuntimeCapabilityIndex(paths: RuntimeLibraryPaths, index: RuntimeCapabilityIndex): Promise<void> {
  await writeText(paths.indexPath, JSON.stringify(index, null, 2));
}

export async function findRuntimeCapability(
  paths: RuntimeLibraryPaths,
  capabilityId: string
): Promise<RuntimeCapabilityRecord | null> {
  const index = await readRuntimeCapabilityIndex(paths);
  return index.capabilities.find((item) => item.id === capabilityId) ?? null;
}

export async function upsertRuntimeCapability(
  paths: RuntimeLibraryPaths,
  capability: RuntimeCapabilityRecord
): Promise<RuntimeCapabilityRecord> {
  const index = await readRuntimeCapabilityIndex(paths);
  const nextItems = index.capabilities.filter((item) => item.id !== capability.id);
  nextItems.push(capability);
  const next: RuntimeCapabilityIndex = {
    updatedAt: nowIso(),
    capabilities: nextItems.sort((a, b) => a.id.localeCompare(b.id))
  };
  await writeRuntimeCapabilityIndex(paths, next);
  return capability;
}
