# MyDarl

Control-plane shell on top of native Codex runtime using Codex SDK.

## Quick start

1. Install deps: `npm install`
2. Build: `npm run build`
3. Run task (blocking until final output):
   `node dist/src/cli/index.js run --task "帮我修这个项目的构建问题"`
   - optional workspace: `--workspace /path/to/target-repo`
4. Run history:
   - `node dist/src/cli/index.js runs list`
   - `node dist/src/cli/index.js runs show <runId> --replay`
5. Capability promotion (pending -> promote/reject):
   - `node dist/src/cli/index.js capabilities pending --run <runId>`
   - `node dist/src/cli/index.js capabilities promote --run <runId> --capability <id>`
   - `node dist/src/cli/index.js capabilities reject --run <runId> --capability <id>`
6. Agent specs and memory:
   - `node dist/src/cli/index.js agents list`
   - `node dist/src/cli/index.js agents show --agent default`
   - `node dist/src/cli/index.js agents memory --agent default --scope local`
7. Observatory web UI:
   - `node dist/src/cli/index.js web --port 4789`
   - `run` command now auto-starts/reuses observatory by default and prints URL to stderr.

## Runtime model

- Engine is `codex-sdk` only.
- CLI calls supervisor; supervisor runs a single main thread and invokes capability factory as runtime service when needed.
- Workflow state is persisted under `runs/<runId>/workflow/`.
- New runtime capabilities are staged in `.mydarl-runtime/staging`; promotion to `config/skills` is explicit.
- Agent memory is persisted under `.mydarl-runtime/memory/agents/<agentId>/local.jsonl` and `.mydarl-runtime/memory/global/distilled.jsonl`.
- If task workspace is inside control-plane root, main execution is forced read-only to prevent self-modifying writes.
- Observatory defaults are in `config/app.yaml -> web` (`autostart`, `host`, `port`).

## Skill protocol

- Runtime skills are loaded from `config/skills/<name>/SKILL.md`.
- Each `SKILL.md` must use Codex-compatible frontmatter:
  - required: `name`, `description`
  - optional custom metadata: `metadata.inject_mode`, `metadata.trigger`, `metadata.limits`
- `metadata.yaml` is optional legacy compatibility and should not be required for new skills.

## Agent Spec

- Primary agent definition lives in `config/agents/<agentId>/agent.md`.
- `agent.md` uses sections:
  - `## Persona`
  - `## Workflow`
  - `## Style`
  - `## Capability-Policy`
- Legacy `config/agent-packs/*` remains as compatibility fallback during migration.
