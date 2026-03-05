# DarlClawv

Conversation-first local all-purpose AI assistant.

## Overview

- Operate through dialogue: you provide a task in natural language.
- Skills-driven execution: features are implemented through Skills.
- Agent runtime is implemented with Codex (`@openai/codex-sdk`).
- Built-in memory system: temporary context + vector recall.
- Self-iteration loop: Top LLM decides retry/escalate/finish/abort.
- Worker runs in a sandbox by default, with explicit escalation flow.

## Architecture

- Top LLM: plan/iterate/approve/rewrite.
- Worker: Codex runtime executes tasks.
- Supervisor: owns the loop, permissions, and memory wiring.

## Conversation-Only Operation

All core operations are triggered by task dialogue:

```bash
node dist/src/cli/index.js run --task "your task"
```

Examples:

- "Fix failing tests with minimal code changes."
- "Split this requirement into 3 steps and execute step 1 first."
- "Analyze risks, then implement a safe patch."
- "If capability is missing, repair and continue."

## Skills-Driven Execution

- The system selects relevant Skills per task.
- Skills define how features are executed.
- New capabilities are added by adding Skills, not by rewriting core flow.
- Canonical user-editable Skills location: `user/skills`.
- System Skills location: `system/skills`.
- Skill definition follows OpenClaw-style `SKILL.md` frontmatter (`name`, `description`, `metadata`).

## Permission Management

- The worker executes inside a sandbox by default.
- If blocked, the Top LLM requests escalation.
- `safe`: fully user-approved (model cannot auto-approve).
- `workspace`: partially model-approved.
- `full`: fully model-approved.

## Quick Start

```bash
npm install
npm run build
node dist/src/cli/index.js run --task "hello"
```
