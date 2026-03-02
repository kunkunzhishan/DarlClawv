import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadAgentSpec, listAgentSpecIds } from "../src/registry/agent-spec.js";

test("loadAgentSpec parses agent.md sections", async () => {
  const spec = await loadAgentSpec("default");
  assert.equal(spec.id, "default");
  assert.ok(spec.persona.length > 0);
  assert.ok(spec.workflow.length > 0);
  assert.ok(spec.style.length > 0);
  assert.ok(spec.capabilityPolicy.length > 0);
});

test("listAgentSpecIds includes default", async () => {
  const ids = await listAgentSpecIds();
  assert.ok(ids.includes("default"));
});

test("loadAgentSpec supports skill_allowlist metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydarl-agent-spec-"));
  const agentDir = path.join(root, "agents", "custom");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "agent.md"),
    `---
id: custom
skill_allowlist:
  - repo-basics
---

## Persona
x

## Workflow
y

## Style
z

## Capability-Policy
p
`,
    "utf8"
  );

  const spec = await loadAgentSpec("custom", path.join(root, "agents"));
  assert.deepEqual(spec.skillWhitelist, ["repo-basics"]);
});

test("loadAgentSpec merges global.md sections into agent.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydarl-agent-spec-"));
  const agentsRoot = path.join(root, "agents");
  const agentDir = path.join(agentsRoot, "custom");
  await mkdir(agentDir, { recursive: true });

  await writeFile(
    path.join(agentsRoot, "global.md"),
    `---
skill_allowlist:
  - global-skill
---

## Persona
global persona

## Workflow
global workflow

## Style
global style

## Capability-Policy
global policy
`,
    "utf8"
  );

  await writeFile(
    path.join(agentDir, "agent.md"),
    `---
id: custom
skill_allowlist:
  - local-skill
---

## Persona
local persona

## Workflow
local workflow

## Style
local style

## Capability-Policy
local policy
`,
    "utf8"
  );

  const spec = await loadAgentSpec("custom", agentsRoot);
  assert.match(spec.persona, /global persona/);
  assert.match(spec.persona, /local persona/);
  assert.match(spec.workflow, /global workflow/);
  assert.match(spec.workflow, /local workflow/);
  assert.deepEqual(spec.skillWhitelist, ["global-skill", "local-skill"]);
});
