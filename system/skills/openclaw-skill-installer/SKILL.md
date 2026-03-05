---
name: openclaw-skill-installer
description: Convert and install an OpenClaw skill into DarlClawv user/skills or system/skills so it can be selected and executed in this runtime.
metadata:
  summary: Import OpenClaw skills with contract conversion and migration report output.
  inject_mode: append
  trigger:
    keywords:
      - openclaw
      - import-skill
      - convert-skill
      - install-skill
      - migrate-skill
  selector:
    short: OpenClaw importer
    usage_hint: Use when user asks to reuse OpenClaw skills here.
    aliases:
      - openclaw-import
      - skills-importer
    tags:
      - interoperability
      - migration
      - skills
  trust_tier: certified
  source_ref: internal
  repair_role: normal
---

# OpenClaw Skill Installer

Use this skill when the user wants an OpenClaw skill to work in DarlClawv.

## Workflow

1. Detect source type:
   - If user provides an external URL/repo path, treat as remote source.
   - If user provides a local absolute path, treat as local source.
2. For remote source:
   - State that network access is required and wait for permission via the supervisor (do not emit protocol JSON).
   - After permission is granted, download/clone the source to a local temp folder, then continue conversion.
   - Do not skip permission flow and do not directly ask for a local path first.
3. For local source:
   - Continue conversion directly.
4. Decide target class before writing files:
   - `system` for runtime/security/dependency skills.
   - `feature` for user-facing capability skills.
5. Copy the source skill folder into:
   - `system/skills/<target-skill-id>` for `system`
   - `user/skills/<target-skill-id>` for `feature`
6. Rewrite target `SKILL.md` frontmatter to DarlClawv contract:
   - required: `name`, `description`, `metadata`
   - keep trigger/selector summary fields when possible
7. Preserve source metadata in target `OPENCLAW_ORIGIN.yaml`.
8. Add target `CONVERSION_REPORT.md` with:
   - source path
   - changed fields
   - memory-related manual review notes
9. After import, inspect:
   - target `SKILL.md`
   - target `CONVERSION_REPORT.md`
10. Continue the user task using the imported skill.

## Constraints

- Only install into `system/skills` or `user/skills`.
- If an external installer defaults to `$CODEX_HOME/skills`, override `CODEX_HOME` or relocate outputs immediately into the target path.
- If class is unclear, default to `user/skills`.
- Do not claim compatibility before checking `CONVERSION_REPORT.md`.
- If conversion warns about memory semantics, explicitly state manual review points.
- For remote URL installs, do not perform network operations until permission is granted.
