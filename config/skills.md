# Skills Index

This file provides lightweight metadata for skill selection.
Canonical skill bodies remain under two directories (OpenClaw-style SKILL contract):
- `config/skills/system/<skill-id>/SKILL.md`
- `config/skills/feature/<skill-id>/SKILL.md`

## repo-basics
```yaml
id: repo-basics
description: Inspect repository structure and implement minimal, testable edits.
summary: Minimal and auditable repo editing workflow.
short: Safe code edits
aliases: [repo, code-edit, patch]
tags: [coding, refactor, bugfix]
usage_hint: Use for most coding tasks that need deterministic edits and validation.
trigger:
  keywords: [repo, code, project, bug, implement]
```
General coding workflow with small, testable changes.

## mcp-recovery
```yaml
id: mcp-recovery
description: Self-repair skill for missing capability, install/setup requests, and MCP/tool failures.
summary: Trusted-first repair loop with mandatory test evidence before resume.
short: MCP/tool repair
aliases: [mcp, tool-recovery, install-tool, self-repair, repair]
tags: [integration, recovery, unblock]
usage_hint: Use for install intent or when blocked by missing MCP/tool capability.
trust_tier: certified
source_ref: openai-skills-github
popularity:
  uses: 100
  success_rate: 0.9
repair_role: repair
trigger:
  keywords: [repair, capability, mcp, tool, server, install, setup, configure, missing, unavailable]
```
Capability recovery skill for blocked execution paths.

## openclaw-skill-installer
```yaml
id: openclaw-skill-installer
description: Convert and install OpenClaw skills into config/skills/feature or config/skills/system for DarlClawv runtime.
summary: One-way OpenClaw compatibility importer.
short: OpenClaw importer
aliases: [openclaw-import, skills-importer, migrate-skill]
tags: [interoperability, migration, skills]
usage_hint: Use when the user wants to reuse an OpenClaw skill here.
trust_tier: certified
source_ref: internal
repair_role: normal
trigger:
  keywords: [openclaw, import-skill, convert-skill, install-skill, migrate-skill]
```
Import workflow for bringing OpenClaw skills into DarlClawv.
