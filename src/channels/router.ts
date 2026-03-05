import type { ChannelAdapter, ChannelConfig, ChannelMessage, ChannelSend, ChannelTriggerConfig } from "./types.js";
import type { ChannelStore } from "./store.js";
import type { RunRequest } from "../types/contracts.js";

type RunTaskFn = typeof import("../core/supervisor/index.js").runTask;

export type ChannelRouter = {
  handleMessage: (message: ChannelMessage) => Promise<void>;
};

export type ChannelRouterOptions = {
  store: ChannelStore;
  adapters: Map<string, ChannelAdapter>;
  channels: Map<string, ChannelConfig>;
  runTask: RunTaskFn;
  controlPlaneRoot?: string;
  defaultAgentId: string;
  maxInflight: number;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

type TriggerDecision = {
  allowed: boolean;
  cleanedText: string;
  reason?: string;
};

function normalizePrefix(prefix?: string): string {
  if (!prefix) {
    return "";
  }
  return prefix;
}

export function shouldHandleMessage(
  message: ChannelMessage,
  trigger?: ChannelTriggerConfig
): TriggerDecision {
  if (message.isBot) {
    return { allowed: false, cleanedText: message.text, reason: "bot-message" };
  }
  if (message.isDirect) {
    return { allowed: true, cleanedText: message.text };
  }
  const mode = trigger?.mode ?? "mention-or-prefix";
  const prefix = normalizePrefix(trigger?.prefix);
  const text = message.text || "";
  if (mode === "direct") {
    return { allowed: true, cleanedText: text };
  }
  if ((mode === "mention" || mode === "mention-or-prefix") && message.mentionsBot) {
    return { allowed: true, cleanedText: text };
  }
  if ((mode === "prefix" || mode === "mention-or-prefix") && prefix && text.startsWith(prefix)) {
    const cleaned = text.slice(prefix.length).trim();
    return { allowed: cleaned.length > 0, cleanedText: cleaned };
  }
  return { allowed: false, cleanedText: text, reason: "not-triggered" };
}

function createLimiter(maxInflight: number) {
  let inflight = 0;
  const queue: Array<() => void> = [];

  const acquire = () =>
    new Promise<() => void>((resolve) => {
      const grant = () => {
        inflight += 1;
        resolve(() => {
          inflight = Math.max(0, inflight - 1);
          const next = queue.shift();
          if (next) {
            next();
          }
        });
      };
      if (inflight < maxInflight) {
        grant();
      } else {
        queue.push(grant);
      }
    });

  return { acquire };
}

export function createChannelRouter(options: ChannelRouterOptions): ChannelRouter {
  const limiter = createLimiter(Math.max(1, options.maxInflight));
  const log = options.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };

  const sendReply = async (send: ChannelSend): Promise<void> => {
    const adapter = options.adapters.get(send.channelId);
    if (!adapter) {
      log.warn(`no adapter found for channel ${send.channelId}`);
      return;
    }
    await adapter.sendMessage(send);
  };

  return {
    handleMessage: async (message) => {
      const release = await limiter.acquire();
      try {
        const channel = options.channels.get(message.channelId);
        if (!channel || channel.enabled === false) {
          return;
        }
        const decision = shouldHandleMessage(message, channel.trigger);
        if (!decision.allowed) {
          return;
        }
        const taskText = decision.cleanedText || message.text;
        if (!taskText.trim()) {
          return;
        }

        const adapter = options.adapters.get(channel.id);
        if (!adapter) {
          log.warn(`adapter missing for channel ${channel.id}`);
          return;
        }

        const chat = options.store.getOrCreateChat({
          channelId: channel.id,
          externalChatId: message.externalChatId,
          agentId: channel.agent_id || options.defaultAgentId
        });

        const inserted = options.store.insertMessage({
          chatId: chat.id,
          externalMessageId: message.externalMessageId,
          role: "user",
          text: message.text,
          ts: message.ts
        });
        if (!inserted) {
          return;
        }

        const request: RunRequest = {
          agentId: chat.agent_id,
          task: taskText,
          threadId: chat.thread_id ?? undefined,
          controlPlaneRoot: options.controlPlaneRoot
        };

        const result = await options.runTask(request);
        const outputText = result.result.outputText?.trim();
        const replyText = outputText
          ? outputText
          : result.result.error
            ? `Task failed: ${result.result.error}`
            : `Task finished with status ${result.result.status}`;

        if (result.result.threadId && result.result.threadId !== chat.thread_id) {
          options.store.updateChatThread(chat.id, result.result.threadId);
        }

        await sendReply({
          channelId: channel.id,
          externalChatId: message.externalChatId,
          text: replyText,
          threadTs: message.threadTs
        });

        options.store.insertMessage({
          chatId: chat.id,
          externalMessageId: `${message.externalMessageId}-assistant`,
          role: "assistant",
          text: replyText,
          ts: new Date().toISOString()
        });
      } catch (error) {
        log.error(`router error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        release();
      }
    }
  };
}
