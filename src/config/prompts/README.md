# Prompt Pack

This directory contains all runtime prompt templates used by DarlClawv.

## Structure

- `common/`: shared wrappers.
- `prompt-compiler/`: main worker prompt composition templates.
  - `messages.md`: consolidated short prompt fragments.
  - `sections.md`: reusable optional section wrappers.
- `skill-selector/`: selector prompt templates.
- `memory/`: memory distill and temporary-classification prompts.
- `skill-manager/`: capability-repair task prompts.
- `supervisor/messages.md`: consolidated escalation and continuation prompts.
- `agent-spec/fallback.md`: consolidated fallback sections when agent markdown is missing sections.

Shared templates are reused where possible (for example, memory section wrappers are shared between prompt compiler and selector).

## Merge Policy

- Agent behavior policy text is merged into existing files:
  - `user/agents/global.md`
  - `user/agents/default/agent.md`
- Reusable runtime/system templates that do not belong to a single agent spec are stored here.
