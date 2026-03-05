---
name: add-feishu
description: "Configure Feishu/Lark channel with a deterministic conversation flow: check existing config first, then collect credentials or guide app creation."
metadata:
  summary: Feishu setup flow with strict first-response behavior.
  inject_mode: append
  trigger:
    keywords:
      - feishu
      - 飞书
      - lark
      - 配飞书
      - 配置飞书
      - add-feishu
      - 我要配飞书
      - 我要配置飞书
      - 我没有，怎么弄
      - 我没有怎么弄
      - 没有怎么创建
      - 没有凭证
      - 不能
      - 不行
      - 没有
      - 没有app id
      - 没有app secret
  selector:
    short: Add Feishu
    usage_hint: Use when user asks to configure Feishu channel.
    aliases:
      - feishu-setup
      - enable-feishu
    tags:
      - integration
      - channels
      - feishu
  trust_tier: certified
  repair_role: normal
---

# Add Feishu Channel

This skill must follow a strict decision flow and produce practical setup guidance.
Respond in the user's language.

## Routing Rules (must follow)

First classify the latest user message:

1. `Initial setup intent`
   - Examples: `我要配飞书`, `配置飞书`.
2. `No-credential intent`
   - Examples: `我没有，怎么弄`, `还没有 App ID`, `没有 App Secret`.
3. `Has-credential intent`
   - User says they can provide App ID/App Secret now.

## Initial setup intent (strict first response)

When intent is initial setup:

1. Check whether Feishu channel already exists in `user/channels.yaml`.
2. Output one short check result sentence.
3. Ask exactly one question:
   - `你现在能直接提供 App ID 和 App Secret 吗？`
4. Do not output long setup steps before this question.

## No-credential intent

When user explicitly says they do not have credentials:

1. Optionally include one short sentence about config check result.
2. Immediately provide setup steps from `FEISHU_SETUP.md`.
3. Keep the same numbered structure (`Step 1` to `Step 7`), do not collapse into short bullets.
4. Include the full permission batch-import JSON block exactly as shown in `FEISHU_SETUP.md`.
5. Include the Lark global note (`domain: lark`) in the setup response.
6. End with a direct request:
   - ask user to come back with `App ID` and `App Secret`.
7. Do not ask the same credential question again in this branch.

### Short-reply rule

If the user only says very short refusal text like `不能`, `不行`, `没有`, treat it as `No-credential intent` immediately.

### Output template for No-credential intent (Chinese)

Use this exact structure and keep it concise:

1. One check sentence:
   - `当前未检测到 Feishu 通道配置（user/channels.yaml）。`
2. Then output `Step 1` to `Step 7` in order (from `FEISHU_SETUP.md`), including the full permission JSON.
3. Final sentence:
   - `完成后把 App ID 和 App Secret 发给我，我继续帮你配置。`

## Branch A: User can provide credentials directly

If user says they can provide App ID / App Secret:

1. Ask for the two values directly.
2. Tell user to put them in env vars (not YAML):
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
3. Configure channel via:
   - preferred: `darlclawv channels setup`
   - fallback: write `user/channels.yaml` with `app_id_env` and `app_secret_env`
4. Ask user to run:
   - `darlclawv channels run`
5. Ask for verification result.

## Required config snippet

When showing manual config, always use env references only:

```yaml
version: 1
channels:
  - id: feishu-default
    kind: feishu
    enabled: true
    skill_id: channel-feishu
    agent_id: default
    trigger:
      mode: mention-or-prefix
      prefix: "claw "
    config:
      app_id_env: FEISHU_APP_ID
      app_secret_env: FEISHU_APP_SECRET
      # domain: lark   # only for Lark overseas
```

## Forbidden

- Do not ask user to put App ID / App Secret directly into YAML.
- Do not mention webhook-only tokens (`FEISHU_ENCRYPT_KEY`, `FEISHU_VERIFICATION_TOKEN`) for this flow.
- Do not mention `npm install` or `npm run build` in this setup flow.
- Do not collapse `No-credential intent` instructions into a brief summary.
- Do not address the user by guessed names (for example, `小张`).
- Do not include any dates unless user explicitly asks for dates.
