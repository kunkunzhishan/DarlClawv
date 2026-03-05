# Feishu App Setup for DarlClawv

Follow this exact flow when the user does not have `App ID` and `App Secret` yet.

## Step 1: Create a Feishu app

1. Open Feishu Open Platform and sign in.
   - Feishu (CN): https://open.feishu.cn/
   - Lark (global): https://open.larksuite.com/app
2. Lark (global) tenants must set `domain: lark` in channel config.

## Step 2: Create an enterprise app

1. Click `Create enterprise app`.
2. Fill in app name and description.
3. Choose an app icon.
4. Create the app.

## Step 3: Copy credentials

From `Credentials & Basic Info`, copy:

- `App ID` (format: `cli_xxx`)
- `App Secret`

Important: keep `App Secret` private.

## Step 4: Configure permissions

On `Permissions`, click `Batch import` and paste:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}
```

## Step 5: Enable bot capability

In `App Capability > Bot`:

1. Enable bot capability.
2. Set the bot name.

## Step 6: Configure event subscription

Important: before setting event subscription, make sure:

1. You already added Feishu channel config (`darlclawv channels setup` or `user/channels.yaml`).
2. Channel gateway is running (`darlclawv channels run`).

Then in `Event Subscription`:

1. Choose `Use long connection to receive events (WebSocket)`.
2. Add event `im.message.receive_v1`.

If gateway is not running, long-connection setup may fail to save.

## Step 7: Publish the app

1. Create a version in `Version Management & Release`.
2. Submit for review and publish.
3. Wait for admin approval (enterprise apps are often auto-approved).

## After platform setup: connect to DarlClawv

Set env vars:

```bash
FEISHU_APP_ID=<your-app-id>
FEISHU_APP_SECRET=<your-app-secret>
```

Manual config fallback (`user/channels.yaml`):

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
      # domain: lark
```

Finally run:

```bash
darlclawv channels run
```
