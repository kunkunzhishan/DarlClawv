import Slack from "@slack/bolt";

const { App } = Slack;

const DEFAULT_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";
const DEFAULT_APP_TOKEN_ENV = "SLACK_APP_TOKEN";
const DEFAULT_SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET";

export function register({ registerChannel }) {
  registerChannel("slack", createChannelAdapter);
}

export function createChannelAdapter({ channelId, config, logger }) {
  const cfg = config?.config || {};
  const botTokenEnv = cfg.bot_token_env || DEFAULT_BOT_TOKEN_ENV;
  const appTokenEnv = cfg.app_token_env || DEFAULT_APP_TOKEN_ENV;
  const signingSecretEnv = cfg.signing_secret_env || DEFAULT_SIGNING_SECRET_ENV;
  const botToken = process.env[botTokenEnv];
  const appToken = process.env[appTokenEnv];
  const signingSecret = process.env[signingSecretEnv];

  if (!botToken || !appToken || !signingSecret) {
    throw new Error(
      `Missing Slack envs: ${[!botToken ? botTokenEnv : null, !appToken ? appTokenEnv : null, !signingSecret ? signingSecretEnv : null]
        .filter(Boolean)
        .join(", ")}`
    );
  }

  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true
  });

  let botUserId = null;
  let connected = false;

  const adapter = {
    async start({ onMessage }) {
      await app.start();
      connected = true;
      try {
        const auth = await app.client.auth.test();
        botUserId = auth?.user_id || auth?.bot_id || null;
      } catch {
        botUserId = null;
      }

      app.event("message", async ({ event }) => {
        const message = event || {};
        const text = typeof message.text === "string" ? message.text : "";
        const isBot = Boolean(message.subtype === "bot_message" || message.bot_id);
        const isDirect = message.channel_type === "im";
        const mentionsBot = botUserId ? text.includes(`<@${botUserId}>`) : false;
        const threadTs = message.thread_ts || undefined;

        onMessage({
          channelId,
          externalChatId: message.channel,
          externalMessageId: message.ts || `${Date.now()}`,
          text,
          ts: message.ts || new Date().toISOString(),
          userId: message.user,
          isBot,
          isDirect,
          mentionsBot,
          threadTs,
          raw: message
        });
      });
      logger?.info?.(`slack adapter started for ${channelId}`);
    },
    async stop() {
      await app.stop();
      connected = false;
    },
    async sendMessage({ externalChatId, text, threadTs }) {
      await app.client.chat.postMessage({
        channel: externalChatId,
        text,
        thread_ts: threadTs
      });
    },
    isConnected() {
      return connected;
    }
  };

  return adapter;
}
