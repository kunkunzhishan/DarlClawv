---
name: channel-feishu
description: Feishu/Lark channel adapter for DarlClawv. Receives messages via Socket Mode and sends replies back to Feishu.
metadata:
  summary: Feishu Socket Mode channel integration.
  inject_mode: append
  channel:
    kind: feishu
    entrypoint: adapter.mjs
    requires_env:
      - FEISHU_APP_ID
      - FEISHU_APP_SECRET
  trigger:
    keywords:
      - feishu
      - lark
      - channel
      - bot
  trust_tier: certified
  repair_role: normal
---

# Feishu Channel Adapter

Provides a Socket Mode Feishu adapter for the channel hub. Configure tokens via env:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
