---
name: repo-basics
description: Inspect repository structure and implement minimal, testable edits for coding tasks.
metadata:
  summary: Keep edits minimal and auditable.
  inject_mode: prepend
  trigger:
    keywords:
      - repo
      - code
      - project
      - bug
      - implement
  limits:
    max_tokens: 1200
---

# Repo Basics

## Workflow

1. Inspect repository structure before editing.
2. Make the smallest change that fully solves the task.
3. Prefer deterministic commands and explicit assumptions.
4. If you run checks, report failures with exact command and error tail.

## Output Expectations

- Explain what changed and why.
- Include file paths touched.
- Include validation commands run (or why not run).
