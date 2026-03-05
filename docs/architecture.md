# DarlClawv Architecture Overview

This note gives a compact, practical view of the system layout and main data flows.

## Core Roles
- **Top LLM (planner/approver/rewrite/distill)**: decides the next instruction, permission advice, and rewrites worker output for the user.
- **Worker (Codex runtime)**: executes tasks, tools, and file operations.
- **Supervisor**: orchestration layer that binds permissions, runs the worker loop, and wires memory.

## Key Directories
- `src/config/` — system configuration, prompts, and policies.
- `user/` — user-owned data (skills, memory, agent specs).
- `system/` — system-owned skills and defaults.
- `.darlclawv-runtime/` — runtime scratch space (sessions, runtime skills, MCP staging, logs).
- `runs/` — run logs, snapshots, and event traces.
- `src/channels/` — channel hub, router, scheduler, and adapters.

## Main Runtime Flow
1. **Supervisor** loads config, agent spec, skills, and memory summaries.
2. **Top LLM** plans a single worker instruction (and skill hints).
3. **Worker** executes the instruction with sandbox + approval settings.
4. **Supervisor** runs an iteration loop and asks Top LLM whether to retry, escalate, finish, or abort.
5. **Top LLM** rewrites worker output for the final reply.
6. **Memory** appends temporary entries and optionally distills to vector stores.

## Memory Layers
- **Temporary memory**: per-agent rolling context in `user/memory/agents/<id>/temporary-context.json`.
- **Personal vector memory**: per-agent durable memory in `user/memory/agents/<id>/personal-vector.json`.
- **Group vector memory**: shared memory in `user/memory/global/group-vector.json`.

## Skills
Skills are loaded from:
- `user/skills` (user-managed)
- `system/skills` (system-managed)

Runtime skills under `.darlclawv-runtime/skills` are not treated as project skills.

## Permissions
Permissions are mapped to fixed profiles:
- **safe**: read-only + no network
- **workspace**: workspace write + no network
- **full**: full access + network

The supervisor is the single place where permission profiles become Codex ThreadOptions.

## Channels (Slack/Feishu)
- Channel hub loads channel configs and channel skills.
- Messages are routed through the same `runTask` pipeline.
- SQLite stores channels, chats, messages, and scheduled tasks.
