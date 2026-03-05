---
name: channel-setup
description: Setup Slack/Feishu channels for DarlClawv via conversation. Delegates to add-slack/add-feishu skills.
metadata:
  summary: Conversational channel setup, channel workflow.
  inject_mode: append
  trigger:
    keywords:
      - setup
      - channel
      - channels
      - slack
      - feishu
      - 飞书
      - lark
      - bot
      - 机器人
      - 配置
  selector:
    short: Channel setup
    usage_hint: Use when the user asks to configure Slack/Feishu channels.
    aliases:
      - add-channel
      - bot-setup
    tags:
      - integration
      - channels
  trust_tier: certified
  repair_role: normal
---

# Channel Setup (Slack/Feishu)

Channel setup flow: detect intent, then delegate to the right channel skill. Keep secrets in environment variables, not in config files. Respond in the user's language.

## Flow
1. If the user explicitly says `Feishu` / `Lark` / `飞书`, invoke `add-feishu` immediately.
2. If the user explicitly says `Slack`, invoke `add-slack` immediately.
3. Only if the user did not specify a channel, ask which channels to enable: Slack, Feishu, or both.
4. After delegated setup, remind the user to start:
   ```bash
   darlclawv channels run
   ```

## Notes
- Do not paste secrets into `user/channels.yaml`.
- Use `.env` or shell env vars for tokens.
- If the user already has a channel configured, skip reconfiguration unless they ask to replace it.
