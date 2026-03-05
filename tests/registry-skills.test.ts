import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkills } from "../src/registry/index.js";

test("loadSkills merges shorthand selector metadata from skills.md", async () => {
  const oldUserRoot = process.env.MYDARL_USER_SKILLS_ROOT;
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "darlclawv-skills-test-"));
  process.env.MYDARL_USER_SKILLS_ROOT = path.join(configRoot, "user", "skills");
  const skillDir = path.join(configRoot, "user", "skills", "repo-basics");
  await mkdir(skillDir, { recursive: true });

  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: repo-basics
description: Base description from SKILL frontmatter
metadata:
  inject_mode: prepend
  trigger:
    keywords: [repo]
---

# Repo Basics
Skill body.
`,
    "utf8"
  );

  await writeFile(
    path.join(configRoot, "skills.md"),
    `# Skills Index

## repo-basics
\`\`\`yaml
id: repo-basics
summary: Markdown summary
aliases: [patch]
tags: [coding]
short: Safe edits
usage_hint: Prefer for deterministic repo changes.
trigger:
  keywords: [bug, implement]
\`\`\`
Selector metadata body.
`,
    "utf8"
  );

  const indexPath = path.join(configRoot, "skills-index.yaml");
  process.env.MYDARL_SKILL_INDEX_PATH = indexPath;
  await writeFile(
    indexPath,
    `version: 1
updated_at: "2026-03-01T00:00:00.000Z"
recommended_sources:
  - id: openai-skills-github
    kind: skill
    url: https://github.com/openai/skills
    domain: github.com
    trust_tier: certified
    enabled: true
skills:
  repo-basics:
    status: active
    trust_tier: popular
    source_ref: openai-skills-github
    popularity:
      uses: 12
      success_rate: 0.8
    repair_role: normal
`,
    "utf8"
  );

  const skills = await loadSkills(configRoot);
  const skill = skills.get("repo-basics");
  assert.ok(skill);
  assert.equal(skill?.meta.summary, "Markdown summary");
  assert.equal(skill?.meta.selector?.short, "Safe edits");
  assert.deepEqual(skill?.meta.selector?.aliases, ["patch"]);
  assert.deepEqual(skill?.meta.selector?.tags, ["coding"]);
  assert.deepEqual(skill?.meta.trigger.keywords, ["repo", "bug", "implement"]);
  assert.equal(skill?.meta.trust_tier, "popular");
  assert.equal(skill?.meta.source_ref, "openai-skills-github");
  assert.equal(skill?.meta.popularity?.uses, 12);
  assert.equal(skill?.meta.repair_role, "normal");

  delete process.env.MYDARL_SKILL_INDEX_PATH;
  if (oldUserRoot === undefined) {
    delete process.env.MYDARL_USER_SKILLS_ROOT;
  } else {
    process.env.MYDARL_USER_SKILLS_ROOT = oldUserRoot;
  }
});

test("loadSkills supports categorized directories under config/skills", async () => {
  const oldSystemRoot = process.env.MYDARL_SYSTEM_SKILLS_ROOT;
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "darlclawv-skills-test-"));
  process.env.MYDARL_SYSTEM_SKILLS_ROOT = path.join(configRoot, "system", "skills");
  const skillDir = path.join(configRoot, "system", "skills", "repo-basics");
  await mkdir(skillDir, { recursive: true });

  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: repo-basics
description: Base description from categorized folder
metadata:
  inject_mode: prepend
---

# Repo Basics
Skill body.
`,
    "utf8"
  );

  const skills = await loadSkills(configRoot);
  assert.equal(skills.has("repo-basics"), true);

  if (oldSystemRoot === undefined) {
    delete process.env.MYDARL_SYSTEM_SKILLS_ROOT;
  } else {
    process.env.MYDARL_SYSTEM_SKILLS_ROOT = oldSystemRoot;
  }
});

test("loadSkills records package entrypoint in global skills index", async () => {
  const oldUserRoot = process.env.MYDARL_USER_SKILLS_ROOT;
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "darlclawv-skills-test-"));
  process.env.MYDARL_USER_SKILLS_ROOT = path.join(configRoot, "user", "skills");
  const skillDir = path.join(configRoot, "user", "skills", "tooling");
  await mkdir(skillDir, { recursive: true });

  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: tooling
description: Tooling skill
metadata:
  inject_mode: prepend
---

# Tooling
Skill body.
`,
    "utf8"
  );

  await writeFile(
    path.join(skillDir, "manifest.yaml"),
    `entrypoint: "python3 config/skills/tooling/scripts/run.py --input-json '{}'"
test: "python3 -m pytest config/skills/tooling/tests"
`,
    "utf8"
  );

  const skills = await loadSkills(configRoot);
  const tooling = skills.get("tooling");
  assert.equal(tooling?.package?.entrypoint, "python3 config/skills/tooling/scripts/run.py --input-json '{}'");
  assert.equal(tooling?.package?.testCommand, "python3 -m pytest config/skills/tooling/tests");

  if (oldUserRoot === undefined) {
    delete process.env.MYDARL_USER_SKILLS_ROOT;
  } else {
    process.env.MYDARL_USER_SKILLS_ROOT = oldUserRoot;
  }
});
