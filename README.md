# DarlClawv

Conversation-first local all-purpose AI assistant.

## Overview

- Operate through dialogue: you provide a task in natural language.
- Skills-driven execution: features are implemented through Skills.
- Agent runtime is implemented with Codex (`@openai/codex-sdk`).
- Built-in memory system: short-term + long-term + vector recall.
- Worker runs in sandbox by default, with explicit escalation flow.

## Architecture

- Agent implementation: Codex runtime (`@openai/codex-sdk`).
- Capability layer: Skills selection + execution + repair flow.
- Memory layer: temporary, local, global, and vector memory.
- Security layer: sandboxed worker + escalation policy.

## Memory Architecture

- Temporary memory: recent context for continuity across turns.
- Local memory: durable memory for the current agent.
- Global memory: reusable cross-agent distilled knowledge.
- Vector memory: personal/group semantic retrieval with compaction.

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
- Repair Skills handle missing tool/capability paths and resume execution.
- Canonical Skills location: `config/skills/system` and `config/skills/feature`.
- Skill definition follows OpenClaw-style `SKILL.md` frontmatter (`name`, `description`, `metadata`).

## Permission Management

- The worker executes inside a sandbox.
- If blocked by permissions, it requests escalation.
- `safe`: fully user-approved (no automatic approval by the model).
- `workspace`: partially model-approved.
- `full`: fully model-approved.

## Quick Start

```bash
npm install
npm run build
node dist/src/cli/index.js run --task "hello"
```
