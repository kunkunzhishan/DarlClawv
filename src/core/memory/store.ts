import path from "node:path";
import { open, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { AppConfig } from "../../types/contracts.js";
import { ensureDir, fileExists, readText } from "../../utils/fs.js";

const VECTOR_DB_VERSION = 1;
const DEFAULT_VECTOR_DIMENSION = 96;
const DEFAULT_PERSONAL_TOP_K = 6;
const DEFAULT_GROUP_TOP_K = 6;
const DEFAULT_TEMPORARY_PROMOTE_THRESHOLD = 24;
const DEFAULT_TEMPORARY_RETAIN_AFTER_PROMOTE = 12;
const DEFAULT_TEMPORARY_MAX_ENTRIES = 200;
const DEFAULT_VECTOR_COMPACTION_SIMILARITY = 0.97;
const DEFAULT_VECTOR_MAX_RECORDS = 5000;
const DEFAULT_EMBEDDING_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_EMBEDDING_MODEL = "embedding-3";
const DEFAULT_EMBEDDING_API_KEY_ENV = "EMBEDDING_API_KEY";
const DEFAULT_EMBEDDING_TIMEOUT_MS = 20000;
const DEFAULT_EMBEDDING_FALLBACK = true;
const DEFAULT_SPLITTER_ENABLED = true;
const DEFAULT_SPLITTER_MAX_CHARS = 400;
const DEFAULT_SPLITTER_OVERLAP_CHARS = 60;
const DEFAULT_SPLITTER_MIN_CHARS = 20;
const FILE_LOCK_RETRY_MS = 25;
const FILE_LOCK_TIMEOUT_MS = 30000;
const FILE_LOCK_STALE_MS = 120000;

export type MemoryPaths = {
  temporaryContextPath: string;
  personalVectorPath: string;
  groupVectorPath: string;
};

export type MemoryRuntimeOptions = {
  vectorDimension: number;
  personalRecallTopK: number;
  groupRecallTopK: number;
  temporaryPromoteThreshold: number;
  temporaryRetainAfterPromote: number;
  temporaryMaxEntries: number;
  vectorCompactionSimilarityThreshold: number;
  vectorMaxRecords: number;
  embeddingProvider: "deterministic" | "openai-compatible";
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingApiKeyEnv: string;
  embeddingTimeoutMs: number;
  embeddingFallbackToDeterministic: boolean;
  splitterEnabled: boolean;
  splitterMaxChars: number;
  splitterOverlapChars: number;
  splitterMinChunkChars: number;
};

export type TemporaryContextEntry = {
  ts: string;
  runId: string;
  agentId: string;
  task: string;
  status: "ok" | "failed";
  outputSummary: string;
};

export type VectorMemoryEntry = {
  id: string;
  ts: string;
  runId: string;
  agentId?: string;
  text: string;
  vector: number[];
  scope: "personal" | "group";
};

export type VectorMemoryHit = {
  id: string;
  ts: string;
  runId: string;
  agentId?: string;
  text: string;
  scope: "personal" | "group";
  score: number;
};

type VectorStoreDocument = {
  version: number;
  dimension: number;
  updatedAt: string;
  records: VectorMemoryEntry[];
};

export type LayeredMemoryRecall = {
  temporary: TemporaryContextEntry[];
  personalHits: VectorMemoryHit[];
  groupHits: VectorMemoryHit[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function trimSummary(text: string, max = 800): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function parseTimeMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

function toRatio(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, n));
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) {
    return 0;
  }
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  if (aNorm <= 0 || bNorm <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function collectLexicalTokens(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const tokens = new Set<string>();
  const wordParts = normalized
    .split(/[\s,.;!?，。！？；:、"'`~!@#$%^&*()_+\-=[\]{}|<>\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of wordParts) {
    if (part.length >= 2) {
      tokens.add(part);
    }
  }

  const cjkChunks = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const chunk of cjkChunks) {
    const chars = Array.from(chunk);
    if (chars.length >= 2) {
      for (let i = 0; i <= chars.length - 2; i += 1) {
        tokens.add(chars.slice(i, i + 2).join(""));
      }
    } else if (chars.length === 1) {
      tokens.add(chars[0]);
    }
    if (chars.length >= 3) {
      for (let i = 0; i <= chars.length - 3; i += 1) {
        tokens.add(chars.slice(i, i + 3).join(""));
      }
    }
  }

  return [...tokens].slice(0, 24);
}

function lexicalMatchBoost(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.trim().toLowerCase();
  if (!q || !t) {
    return 0;
  }
  let score = 0;
  if (t.includes(q)) {
    score += 0.45;
  }
  const tokens = collectLexicalTokens(q);
  for (const token of tokens) {
    if (t.includes(token)) {
      score += token.length >= 3 ? 0.09 : 0.06;
    }
  }
  return Math.min(0.8, score);
}

function deterministicEmbedding(text: string, dimension: number): number[] {
  const out = new Array<number>(dimension).fill(0);
  const normalized = text.toLowerCase().trim();
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    const slotA = (code * 31 + i * 17) % dimension;
    const slotB = (code * 13 + i * 29) % dimension;
    out[slotA] += (code % 11) + 1;
    out[slotB] += (code % 7) + 0.5;
  }
  const norm = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0));
  if (norm <= 0) {
    return out;
  }
  return out.map((v) => v / norm);
}

function splitTextForEmbedding(text: string, options: MemoryRuntimeOptions): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return [];
  }
  if (!options.splitterEnabled || normalized.length <= options.splitterMaxChars) {
    return [normalized];
  }

  const units = normalized
    .split(/(?<=[。！？.!?;；\n])/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (units.length === 0) {
    return [normalized];
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    const next = `${current} ${unit}`.trim();
    if (next.length <= options.splitterMaxChars) {
      current = next;
      continue;
    }
    if (current.length >= options.splitterMinChunkChars) {
      chunks.push(current);
    }
    const overlap = current.slice(Math.max(0, current.length - options.splitterOverlapChars)).trim();
    current = overlap ? `${overlap} ${unit}`.trim() : unit;
  }
  if (current.length >= options.splitterMinChunkChars) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [normalized];
}

async function remoteEmbedding(text: string, options: MemoryRuntimeOptions): Promise<number[]> {
  const apiKey = process.env[options.embeddingApiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `Missing embedding api key env: ${options.embeddingApiKeyEnv} (provider=openai-compatible)`
    );
  }

  const url = `${options.embeddingBaseUrl.replace(/\/+$/, "")}/embeddings`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.embeddingTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: options.embeddingModel,
        input: text,
        dimensions: options.vectorDimension
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Embedding endpoint failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Embedding response missing data[0].embedding");
    }
    const numbers = vector.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (numbers.length === 0) {
      throw new Error("Embedding vector is empty");
    }
    return numbers;
  } finally {
    clearTimeout(timeout);
  }
}

async function embedText(text: string, options: MemoryRuntimeOptions, dimension: number): Promise<number[]> {
  if (options.embeddingProvider === "openai-compatible") {
    try {
      const remote = await remoteEmbedding(text, options);
      const target = remote.length === dimension ? remote : remote.slice(0, dimension);
      if (target.length < dimension) {
        return [...target, ...new Array<number>(dimension - target.length).fill(0)];
      }
      return target;
    } catch (error) {
      if (!options.embeddingFallbackToDeterministic) {
        throw error;
      }
    }
  }
  return deterministicEmbedding(text, dimension);
}

async function ensureMemoryPath(pathValue: string): Promise<void> {
  await ensureDir(path.dirname(pathValue));
}

async function writeTextAtomic(pathValue: string, content: string): Promise<void> {
  await ensureMemoryPath(pathValue);
  const tempPath = `${pathValue}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, pathValue);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function archiveCorruptFile(pathValue: string): Promise<void> {
  const archived = `${pathValue}.corrupt-${Date.now()}`;
  await rename(pathValue, archived).catch(() => undefined);
}

async function withFileLock<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${pathValue}.lock`;
  await ensureMemoryPath(lockPath);
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid), "utf8").catch(() => undefined);
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await stat(lockPath);
        const age = Date.now() - lockStat.mtimeMs;
        if (age >= FILE_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // Ignore stat/unlink race and retry.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for memory file lock: ${lockPath}`);
      }
      await sleep(FILE_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }
  try {
    const raw = await readText(filePath);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    if (error instanceof SyntaxError) {
      await archiveCorruptFile(filePath);
    }
    return [];
  }
}

async function writeJsonArray<T>(filePath: string, items: T[]): Promise<void> {
  await ensureMemoryPath(filePath);
  await writeTextAtomic(filePath, JSON.stringify(items, null, 2));
}

async function readVectorStore(pathValue: string, dimension: number): Promise<VectorStoreDocument> {
  if (!(await fileExists(pathValue))) {
    return {
      version: VECTOR_DB_VERSION,
      dimension,
      updatedAt: nowIso(),
      records: []
    };
  }

  try {
    const raw = await readText(pathValue);
    const parsed = JSON.parse(raw) as Partial<VectorStoreDocument>;
    const parsedDimension = toPositiveInt(parsed.dimension, dimension);
    const records = Array.isArray(parsed.records)
      ? parsed.records.filter((item): item is VectorMemoryEntry => {
          return Boolean(
            item &&
              typeof item.id === "string" &&
              typeof item.ts === "string" &&
              typeof item.runId === "string" &&
              typeof item.text === "string" &&
              (item.scope === "personal" || item.scope === "group") &&
              Array.isArray(item.vector)
          );
        })
      : [];
    return {
      version: VECTOR_DB_VERSION,
      dimension: parsedDimension,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
      records
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      await archiveCorruptFile(pathValue);
    }
    return {
      version: VECTOR_DB_VERSION,
      dimension,
      updatedAt: nowIso(),
      records: []
    };
  }
}

async function writeVectorStore(pathValue: string, doc: VectorStoreDocument): Promise<void> {
  await ensureMemoryPath(pathValue);
  await writeTextAtomic(
    pathValue,
    JSON.stringify(
      {
        version: VECTOR_DB_VERSION,
        dimension: doc.dimension,
        updatedAt: nowIso(),
        records: doc.records
      },
      null,
      2
    )
  );
}

function toVectorEntry(args: {
  scope: "personal" | "group";
  ts: string;
  runId: string;
  agentId?: string;
  text: string;
  dimension: number;
}): VectorMemoryEntry {
  const cleanText = args.text.trim();
  const hashBase = `${args.scope}|${args.runId}|${args.ts}|${cleanText}`;
  const id = `vec_${Buffer.from(hashBase).toString("base64url").slice(0, 24)}`;
  return {
    id,
    ts: args.ts,
    runId: args.runId,
    agentId: args.agentId,
    text: cleanText,
    vector: deterministicEmbedding(cleanText, args.dimension),
    scope: args.scope
  };
}

async function appendVectorEntries(args: {
  pathValue: string;
  scope: "personal" | "group";
  entries: Array<{ ts: string; runId: string; text: string; agentId?: string }>;
  options: MemoryRuntimeOptions;
  maxRecords: number;
}): Promise<number> {
  const valid: Array<{ ts: string; runId: string; text: string; agentId?: string }> = [];
  for (const entry of args.entries) {
    for (const chunk of splitTextForEmbedding(entry.text, args.options)) {
      valid.push({
        ...entry,
        text: chunk
      });
    }
  }
  if (valid.length === 0) {
    return 0;
  }

  return await withFileLock(args.pathValue, async () => {
    const doc = await readVectorStore(args.pathValue, args.options.vectorDimension);
    const inserted: VectorMemoryEntry[] = [];
    for (const entry of valid) {
      inserted.push({
        ...toVectorEntry({
          scope: args.scope,
          ts: entry.ts,
          runId: entry.runId,
          text: entry.text,
          agentId: entry.agentId,
          dimension: doc.dimension
        }),
        vector: await embedText(entry.text, args.options, doc.dimension)
      });
    }
    const next = [...doc.records, ...inserted];

    const trimmed = next.length > args.maxRecords ? next.slice(next.length - args.maxRecords) : next;
    await writeVectorStore(args.pathValue, {
      ...doc,
      records: trimmed
    });
    return inserted.length;
  });
}

async function searchVectorEntries(args: {
  pathValue: string;
  query: string;
  topK: number;
  options: MemoryRuntimeOptions;
}): Promise<VectorMemoryHit[]> {
  const query = args.query.trim();
  if (!query) {
    return [];
  }
  const doc = await readVectorStore(args.pathValue, args.options.vectorDimension);
  if (doc.records.length === 0) {
    return [];
  }
  const queryVector = await embedText(query, args.options, doc.dimension);
  return doc.records
    .map((record) => ({
      id: record.id,
      ts: record.ts,
      runId: record.runId,
      agentId: record.agentId,
      text: record.text,
      scope: record.scope,
      score: cosineSimilarity(queryVector, record.vector) + lexicalMatchBoost(query, record.text)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, args.topK));
}

async function compactVectorStore(args: {
  pathValue: string;
  dimension: number;
  similarityThreshold: number;
  maxRecords: number;
}): Promise<{ before: number; after: number }> {
  return await withFileLock(args.pathValue, async () => {
    const doc = await readVectorStore(args.pathValue, args.dimension);
    const before = doc.records.length;
    if (before <= 1) {
      return { before, after: before };
    }

    const ordered = [...doc.records].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    const kept: VectorMemoryEntry[] = [];
    for (const candidate of ordered) {
      const isNearDuplicate = kept.some((existing) => cosineSimilarity(existing.vector, candidate.vector) >= args.similarityThreshold);
      if (!isNearDuplicate) {
        kept.push(candidate);
      }
      if (kept.length >= args.maxRecords) {
        break;
      }
    }

    const normalized = kept.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    await writeVectorStore(args.pathValue, {
      ...doc,
      records: normalized
    });
    return { before, after: normalized.length };
  });
}

export function resolveMemoryPaths(appConfig: AppConfig, agentId: string): MemoryPaths {
  const agentRoot = path.resolve(appConfig.memory.local_store_root, agentId);
  return {
    temporaryContextPath: path.join(agentRoot, "temporary-context.json"),
    personalVectorPath: path.join(agentRoot, "personal-vector.json"),
    groupVectorPath: path.resolve(appConfig.memory.global_vector_store_path)
  };
}

export function resolveMemoryRuntimeOptions(appConfig: AppConfig): MemoryRuntimeOptions {
  const vectorCfg = appConfig.memory.vector || {};
  const temporaryCfg = appConfig.memory.temporary || {};
  const embeddingCfg = vectorCfg.embedding || {};
  const splitterCfg = vectorCfg.splitter || {};
  const provider = embeddingCfg.provider === "openai-compatible" ? "openai-compatible" : "deterministic";
  return {
    vectorDimension: toPositiveInt(vectorCfg.dimension, DEFAULT_VECTOR_DIMENSION),
    personalRecallTopK: toPositiveInt(vectorCfg.personal_recall_top_k, DEFAULT_PERSONAL_TOP_K),
    groupRecallTopK: toPositiveInt(vectorCfg.group_recall_top_k, DEFAULT_GROUP_TOP_K),
    temporaryPromoteThreshold: toPositiveInt(
      temporaryCfg.promote_threshold,
      DEFAULT_TEMPORARY_PROMOTE_THRESHOLD
    ),
    temporaryRetainAfterPromote: toPositiveInt(
      temporaryCfg.retain_after_promote,
      DEFAULT_TEMPORARY_RETAIN_AFTER_PROMOTE
    ),
    temporaryMaxEntries: toPositiveInt(temporaryCfg.max_entries, DEFAULT_TEMPORARY_MAX_ENTRIES),
    vectorCompactionSimilarityThreshold: toRatio(
      vectorCfg.compaction_similarity_threshold,
      DEFAULT_VECTOR_COMPACTION_SIMILARITY
    ),
    vectorMaxRecords: toPositiveInt(vectorCfg.max_records, DEFAULT_VECTOR_MAX_RECORDS),
    embeddingProvider: provider,
    embeddingBaseUrl: String(embeddingCfg.base_url || DEFAULT_EMBEDDING_BASE_URL),
    embeddingModel: String(embeddingCfg.model || DEFAULT_EMBEDDING_MODEL),
    embeddingApiKeyEnv: String(embeddingCfg.api_key_env || DEFAULT_EMBEDDING_API_KEY_ENV),
    embeddingTimeoutMs: toPositiveInt(embeddingCfg.timeout_ms, DEFAULT_EMBEDDING_TIMEOUT_MS),
    embeddingFallbackToDeterministic:
      typeof embeddingCfg.fallback_to_deterministic === "boolean"
        ? embeddingCfg.fallback_to_deterministic
        : DEFAULT_EMBEDDING_FALLBACK,
    splitterEnabled:
      typeof splitterCfg.enabled === "boolean" ? splitterCfg.enabled : DEFAULT_SPLITTER_ENABLED,
    splitterMaxChars: toPositiveInt(splitterCfg.max_chars, DEFAULT_SPLITTER_MAX_CHARS),
    splitterOverlapChars: toNonNegativeInt(splitterCfg.overlap_chars, DEFAULT_SPLITTER_OVERLAP_CHARS),
    splitterMinChunkChars: toPositiveInt(splitterCfg.min_chunk_chars, DEFAULT_SPLITTER_MIN_CHARS)
  };
}

export async function appendTemporaryContext(args: {
  paths: MemoryPaths;
  entry: TemporaryContextEntry;
  maxEntries: number;
}): Promise<number> {
  return await withFileLock(args.paths.temporaryContextPath, async () => {
    const items = await readJsonArray<TemporaryContextEntry>(args.paths.temporaryContextPath);
    const next = [...items, args.entry];
    const trimmed = next.length > args.maxEntries ? next.slice(next.length - args.maxEntries) : next;
    await writeJsonArray(args.paths.temporaryContextPath, trimmed);
    return trimmed.length;
  });
}

export async function readTemporaryContext(paths: MemoryPaths, limit = 12): Promise<TemporaryContextEntry[]> {
  const items = await readJsonArray<TemporaryContextEntry>(paths.temporaryContextPath);
  return items.slice(Math.max(0, items.length - limit));
}

export async function countTemporaryContext(paths: MemoryPaths): Promise<number> {
  const items = await readJsonArray<TemporaryContextEntry>(paths.temporaryContextPath);
  return items.length;
}

export async function retainTemporaryContext(paths: MemoryPaths, retainCount: number): Promise<void> {
  await withFileLock(paths.temporaryContextPath, async () => {
    const items = await readJsonArray<TemporaryContextEntry>(paths.temporaryContextPath);
    const trimmed = items.slice(Math.max(0, items.length - retainCount));
    await writeJsonArray(paths.temporaryContextPath, trimmed);
  });
}

export async function appendPersonalVectorMemories(args: {
  paths: MemoryPaths;
  entries: Array<{ ts: string; runId: string; text: string; agentId: string }>;
  options: MemoryRuntimeOptions;
}): Promise<number> {
  return await appendVectorEntries({
    pathValue: args.paths.personalVectorPath,
    scope: "personal",
    entries: args.entries,
    options: args.options,
    maxRecords: args.options.vectorMaxRecords
  });
}

export async function appendGroupVectorMemories(args: {
  paths: MemoryPaths;
  entries: Array<{ ts: string; runId: string; text: string; agentId?: string }>;
  options: MemoryRuntimeOptions;
}): Promise<number> {
  return await appendVectorEntries({
    pathValue: args.paths.groupVectorPath,
    scope: "group",
    entries: args.entries,
    options: args.options,
    maxRecords: args.options.vectorMaxRecords
  });
}

export async function searchPersonalVectorMemory(args: {
  paths: MemoryPaths;
  query: string;
  topK: number;
  options: MemoryRuntimeOptions;
}): Promise<VectorMemoryHit[]> {
  return await searchVectorEntries({
    pathValue: args.paths.personalVectorPath,
    query: args.query,
    topK: args.topK,
    options: args.options
  });
}

export async function searchGroupVectorMemory(args: {
  paths: MemoryPaths;
  query: string;
  topK: number;
  options: MemoryRuntimeOptions;
}): Promise<VectorMemoryHit[]> {
  return await searchVectorEntries({
    pathValue: args.paths.groupVectorPath,
    query: args.query,
    topK: args.topK,
    options: args.options
  });
}

export async function readRecentPersonalVectorMemory(args: {
  paths: MemoryPaths;
  limit: number;
  options: MemoryRuntimeOptions;
}): Promise<VectorMemoryEntry[]> {
  const doc = await readVectorStore(args.paths.personalVectorPath, args.options.vectorDimension);
  return doc.records.slice(Math.max(0, doc.records.length - args.limit));
}

export async function readRecentGroupVectorMemory(args: {
  paths: MemoryPaths;
  limit: number;
  options: MemoryRuntimeOptions;
}): Promise<VectorMemoryEntry[]> {
  const doc = await readVectorStore(args.paths.groupVectorPath, args.options.vectorDimension);
  return doc.records.slice(Math.max(0, doc.records.length - args.limit));
}

export async function compactVectorMemories(args: {
  paths: MemoryPaths;
  options: MemoryRuntimeOptions;
}): Promise<{
  personal: { before: number; after: number };
  group: { before: number; after: number };
}> {
  const [personal, group] = await Promise.all([
    compactVectorStore({
      pathValue: args.paths.personalVectorPath,
      dimension: args.options.vectorDimension,
      similarityThreshold: args.options.vectorCompactionSimilarityThreshold,
      maxRecords: args.options.vectorMaxRecords
    }),
    compactVectorStore({
      pathValue: args.paths.groupVectorPath,
      dimension: args.options.vectorDimension,
      similarityThreshold: args.options.vectorCompactionSimilarityThreshold,
      maxRecords: args.options.vectorMaxRecords
    })
  ]);
  return { personal, group };
}

export async function recallLayeredMemory(args: {
  paths: MemoryPaths;
  query: string;
  options: MemoryRuntimeOptions;
  temporaryLimit?: number;
}): Promise<LayeredMemoryRecall> {
  const temporaryLimit = args.temporaryLimit ?? 8;
  const [allTemporary, personalHits, groupHits] = await Promise.all([
    readJsonArray<TemporaryContextEntry>(args.paths.temporaryContextPath),
    searchPersonalVectorMemory({
      paths: args.paths,
      query: args.query,
      topK: args.options.personalRecallTopK,
      options: args.options
    }),
    searchGroupVectorMemory({
      paths: args.paths,
      query: args.query,
      topK: args.options.groupRecallTopK,
      options: args.options
    })
  ]);

  const q = args.query.trim().toLowerCase();
  const scoredTemporary = allTemporary.map((entry) => {
    const haystack = `${entry.task}\n${entry.outputSummary}`;
    return {
      entry,
      score: lexicalMatchBoost(q, haystack),
      ts: parseTimeMs(entry.ts)
    };
  });
  const selectedByMatch = scoredTemporary
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
    .slice(0, temporaryLimit)
    .map((item) => item.entry);
  const selectedIds = new Set(selectedByMatch.map((entry) => `${entry.runId}|${entry.ts}`));
  const fallbackRecent = allTemporary
    .slice()
    .sort((a, b) => parseTimeMs(b.ts) - parseTimeMs(a.ts))
    .filter((entry) => !selectedIds.has(`${entry.runId}|${entry.ts}`))
    .slice(0, Math.max(0, temporaryLimit - selectedByMatch.length));
  const temporary = [...selectedByMatch, ...fallbackRecent].sort((a, b) => parseTimeMs(a.ts) - parseTimeMs(b.ts));

  return {
    temporary,
    personalHits,
    groupHits
  };
}

export function summarizeLayeredLocalMemory(recall: LayeredMemoryRecall): string {
  const parts: string[] = [];
  if (recall.temporary.length > 0) {
    parts.push(
      "[TEMPORARY_CONTEXT]",
      ...recall.temporary.map((entry) =>
        `[${entry.ts}] task="${trimSummary(entry.task, 100)}" status=${entry.status} summary="${trimSummary(entry.outputSummary, 180)}"`
      )
    );
  }
  if (recall.personalHits.length > 0) {
    parts.push(
      "[PERSONAL_VECTOR_MEMORY]",
      ...recall.personalHits.map((hit) => `[score=${hit.score.toFixed(3)}] ${trimSummary(hit.text, 220)}`)
    );
  }
  return parts.length > 0 ? parts.join("\n") : "No personal memory yet.";
}

export function summarizeLayeredGroupMemory(recall: LayeredMemoryRecall): string {
  if (recall.groupHits.length === 0) {
    return "No group memory yet.";
  }
  return [
    "[GROUP_VECTOR_MEMORY]",
    ...recall.groupHits.map((hit) => `[score=${hit.score.toFixed(3)}] ${trimSummary(hit.text, 220)}`)
  ].join("\n");
}
