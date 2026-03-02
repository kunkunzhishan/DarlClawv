import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAppConfig } from "../src/registry/index.js";

test("loadAppConfig reads memory embedding and splitter from env overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydarl-config-env-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "app.yaml"),
    `default_policy: safe-default
engine:
  provider: codex-sdk
  model: gpt-5-codex
`,
    "utf8"
  );

  const old = {
    provider: process.env.MYDARL_MEMORY_EMBEDDING_PROVIDER,
    model: process.env.MYDARL_MEMORY_EMBEDDING_MODEL,
    splitterEnabled: process.env.MYDARL_MEMORY_SPLITTER_ENABLED,
    splitterMax: process.env.MYDARL_MEMORY_SPLITTER_MAX_CHARS
  };

  process.env.MYDARL_MEMORY_EMBEDDING_PROVIDER = "openai-compatible";
  process.env.MYDARL_MEMORY_EMBEDDING_MODEL = "embedding-custom";
  process.env.MYDARL_MEMORY_SPLITTER_ENABLED = "false";
  process.env.MYDARL_MEMORY_SPLITTER_MAX_CHARS = "256";

  try {
    const config = await loadAppConfig(root);
    assert.equal(config.memory.vector?.embedding?.provider, "openai-compatible");
    assert.equal(config.memory.vector?.embedding?.model, "embedding-custom");
    assert.equal(config.memory.vector?.splitter?.enabled, false);
    assert.equal(config.memory.vector?.splitter?.max_chars, 256);
  } finally {
    if (old.provider === undefined) {
      delete process.env.MYDARL_MEMORY_EMBEDDING_PROVIDER;
    } else {
      process.env.MYDARL_MEMORY_EMBEDDING_PROVIDER = old.provider;
    }
    if (old.model === undefined) {
      delete process.env.MYDARL_MEMORY_EMBEDDING_MODEL;
    } else {
      process.env.MYDARL_MEMORY_EMBEDDING_MODEL = old.model;
    }
    if (old.splitterEnabled === undefined) {
      delete process.env.MYDARL_MEMORY_SPLITTER_ENABLED;
    } else {
      process.env.MYDARL_MEMORY_SPLITTER_ENABLED = old.splitterEnabled;
    }
    if (old.splitterMax === undefined) {
      delete process.env.MYDARL_MEMORY_SPLITTER_MAX_CHARS;
    } else {
      process.env.MYDARL_MEMORY_SPLITTER_MAX_CHARS = old.splitterMax;
    }
  }
});
