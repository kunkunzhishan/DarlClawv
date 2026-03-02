import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolveEntrypointPathInRoot, resolvePathInRoot } from "../src/core/skill-manager/index.js";
import { toRuntimePermission } from "../src/core/security/permissions.js";

test("resolvePathInRoot accepts paths inside root", () => {
  const root = path.resolve("/tmp/darlclawv-staging");
  const resolved = resolvePathInRoot("skills/my-tool", root);
  assert.equal(resolved, path.resolve(root, "skills/my-tool"));
});

test("resolvePathInRoot rejects traversal outside root", () => {
  const root = path.resolve("/tmp/darlclawv-staging");
  const resolved = resolvePathInRoot("../src", root);
  assert.equal(resolved, null);
});

test("resolveEntrypointPathInRoot resolves staged script path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "darlclawv-entrypoint-test-"));
  const script = path.join(root, "scripts", "tool.py");
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, "print('ok')\n", "utf8");
  const resolved = await resolveEntrypointPathInRoot("python3 scripts/tool.py --input x", root);
  assert.equal(resolved, script);
});

test("toRuntimePermission maps safe/workspace/full profiles", () => {
  assert.deepEqual(toRuntimePermission("safe"), {
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
    networkAccessEnabled: false
  });

  assert.deepEqual(toRuntimePermission("workspace"), {
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    networkAccessEnabled: false
  });

  assert.deepEqual(toRuntimePermission("full"), {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    networkAccessEnabled: true
  });
});
