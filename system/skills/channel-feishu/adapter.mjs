import Lark from "@larksuiteoapi/node-sdk";

const { Client, WSClient, EventDispatcher, Domain, LoggerLevel } = Lark;

const DEFAULT_APP_ID_ENV = "FEISHU_APP_ID";
const DEFAULT_APP_SECRET_ENV = "FEISHU_APP_SECRET";

export function register({ registerChannel }) {
  registerChannel("feishu", createChannelAdapter);
}

function parseText(content) {
  if (!content) {
    return "";
  }
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    if (parsed?.text) {
      return String(parsed.text);
    }
  } catch {
    // ignore
  }
  return typeof content === "string" ? content : "";
}

export function createChannelAdapter({ channelId, config, logger }) {
  const cfg = config?.config || {};
  const appIdEnv = cfg.app_id_env || DEFAULT_APP_ID_ENV;
  const appSecretEnv = cfg.app_secret_env || DEFAULT_APP_SECRET_ENV;
  const appId = process.env[appIdEnv];
  const appSecret = process.env[appSecretEnv];
  if (!appId || !appSecret) {
    throw new Error(
      `Missing Feishu envs: ${[!appId ? appIdEnv : null, !appSecret ? appSecretEnv : null]
        .filter(Boolean)
        .join(", ")}`
    );
  }

  const domain = cfg.domain === "lark" ? Domain.Lark : Domain.Feishu;
  const client = new Client({ appId, appSecret, domain });
  let wsClient = null;
  let connected = false;

  const adapter = {
    async start({ onMessage }) {
      const dispatcher = new EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const message = data?.message || {};
          const text = parseText(message.content);
          const isDirect = message.chat_type === "p2p";
          const mentionsBot = Array.isArray(message.mentions) && message.mentions.length > 0;
          onMessage({
            channelId,
            externalChatId: message.chat_id,
            externalMessageId: message.message_id || `${Date.now()}`,
            text,
            ts: message.create_time ? new Date(Number(message.create_time)).toISOString() : new Date().toISOString(),
            userId: data?.sender?.sender_id?.user_id || data?.sender?.sender_id?.open_id,
            isBot: false,
            isDirect,
            mentionsBot,
            raw: data
          });
        }
      });

      wsClient = new WSClient({
        appId,
        appSecret,
        domain,
        loggerLevel: LoggerLevel.error
      });
      wsClient.start({ eventDispatcher: dispatcher });
      connected = true;
      logger?.info?.(`feishu adapter started for ${channelId}`);
    },
    async stop() {
      if (wsClient?.stop) {
        await wsClient.stop();
      }
      connected = false;
    },
    async sendMessage({ externalChatId, text }) {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: externalChatId,
          msg_type: "text",
          content: JSON.stringify({ text })
        }
      });
    },
    isConnected() {
      return connected;
    }
  };

  return adapter;
}
