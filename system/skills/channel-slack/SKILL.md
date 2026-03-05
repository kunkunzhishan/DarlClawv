---
name: channel-slack
description: Slack channel adapter for DarlClawv. Receives messages via Socket Mode and sends replies back to Slack.
metadata:
  summary: Slack Socket Mode channel integration.
  inject_mode: append
  channel:
    kind: slack
    entrypoint: adapter.mjs
    requires_env:
      - SLACK_BOT_TOKEN
      - SLACK_APP_TOKEN
      - SLACK_SIGNING_SECRET
  trigger:
    keywords:
      - slack
      - channel
      - bot
  trust_tier: certified
  repair_role: normal
---

# Slack Channel Adapter

Provides a Socket Mode Slack adapter for the channel hub. Configure tokens via env:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`
