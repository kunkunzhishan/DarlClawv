import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolveEntrypointPathInRoot, resolvePathInRoot } from "../src/core/skill-manager/index.js";
import {
  isPathAllowedByRoots,
  isPathBlockedByRoots,
  violatesAddOnlyRoots
} from "../src/runtime/codex-sdk/client.js";

test("resolvePathInRoot accepts paths inside root", () => {
  const root = path.resolve("/tmp/mydarl-staging");
  const resolved = resolvePathInRoot("skills/my-tool", root);
  assert.equal(resolved, path.resolve(root, "skills/my-tool"));
});

test("resolvePathInRoot rejects traversal outside root", () => {
  const root = path.resolve("/tmp/mydarl-staging");
  const resolved = resolvePathInRoot("../src", root);
  assert.equal(resolved, null);
});

test("isPathAllowedByRoots allows file changes only within configured roots", () => {
  const workdir = path.resolve("/tmp/mydarl-staging");
  assert.equal(
    isPathAllowedByRoots({
      candidatePath: "skills/my-tool/SKILL.md",
      workingDirectory: workdir,
      allowedWriteRoots: [workdir]
    }),
    true
  );

  assert.equal(
    isPathAllowedByRoots({
      candidatePath: "/tmp/not-allowed/file.ts",
      workingDirectory: workdir,
      allowedWriteRoots: [workdir]
    }),
    false
  );
});

test("isPathBlockedByRoots rejects changes in forbidden root", () => {
  const workdir = path.resolve("/tmp/mydarl-staging");
  assert.equal(
    isPathBlockedByRoots({
      candidatePath: "/tmp/control-plane/src/index.ts",
      workingDirectory: workdir,
      forbiddenRoots: ["/tmp/control-plane"]
    }),
    true
  );
});

test("add-only roots allow add but reject update/delete", () => {
  const workdir = path.resolve("/tmp/mydarl-staging");
  const addOnlyRoots = ["/tmp/mydarl-control/config/skills"];

  assert.equal(
    violatesAddOnlyRoots({
      changeKind: "add",
      candidatePath: "/tmp/mydarl-control/config/skills/new-skill/SKILL.md",
      workingDirectory: workdir,
      addOnlyRoots
    }),
    false
  );

  assert.equal(
    violatesAddOnlyRoots({
      changeKind: "update",
      candidatePath: "/tmp/mydarl-control/config/skills/existing/SKILL.md",
      workingDirectory: workdir,
      addOnlyRoots
    }),
    true
  );
});

test("resolveEntrypointPathInRoot resolves staged script path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydarl-entrypoint-test-"));
  const script = path.join(root, "scripts", "tool.py");
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, "print('ok')\n", "utf8");
  const resolved = await resolveEntrypointPathInRoot("python3 scripts/tool.py --input x", root);
  assert.equal(resolved, script);
});
