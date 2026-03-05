import cronParser from "cron-parser";
import type { ChannelAdapter, ChannelConfig } from "./types.js";
import type { ChannelStore, ScheduledTaskRecord } from "./store.js";
import type { RunRequest } from "../types/contracts.js";

type RunTaskFn = typeof import("../core/supervisor/index.js").runTask;

export type ChannelScheduler = {
  stop: () => void;
};

export type ChannelSchedulerOptions = {
  store: ChannelStore;
  adapters: Map<string, ChannelAdapter>;
  channels: Map<string, ChannelConfig>;
  runTask: RunTaskFn;
  controlPlaneRoot?: string;
  intervalMs: number;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

function computeNextRun(cron: string, now: Date): string | null {
  try {
    const interval = cronParser.parseExpression(cron, { currentDate: now });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

async function executeTask(
  task: ScheduledTaskRecord,
  options: ChannelSchedulerOptions
): Promise<void> {
  const chat = options.store.getChatById(task.chat_id);
  if (!chat) {
    return;
  }
  const channel = options.channels.get(chat.channel_id);
  if (!channel) {
    return;
  }
  const adapter = options.adapters.get(channel.id);
  if (!adapter) {
    return;
  }
  const request: RunRequest = {
    agentId: chat.agent_id,
    task: task.task,
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
  await adapter.sendMessage({
    channelId: channel.id,
    externalChatId: chat.external_chat_id,
    text: replyText
  });
  options.store.insertMessage({
    chatId: chat.id,
    externalMessageId: `${task.id}-assistant-${Date.now()}`,
    role: "assistant",
    text: replyText,
    ts: nowIso()
  });
}

export function startChannelScheduler(options: ChannelSchedulerOptions): ChannelScheduler {
  const log = options.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
  const interval = Math.max(1000, options.intervalMs);
  const timer = setInterval(async () => {
    const now = new Date();
    const due = options.store.listDueScheduledTasks(now.toISOString());
    for (const task of due) {
      await executeTask(task, options);
      const next = computeNextRun(task.cron, now);
      if (!next) {
        log.warn(`invalid cron expression: ${task.cron}`);
        continue;
      }
      options.store.updateScheduledTaskNextRun(task.id, next);
    }
  }, interval);

  return {
    stop: () => clearInterval(timer)
  };
}
