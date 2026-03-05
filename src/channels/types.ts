export type ChannelTriggerConfig = {
  mode?: "mention" | "prefix" | "mention-or-prefix" | "direct";
  prefix?: string;
};

export type ChannelConfig = {
  id: string;
  kind: string;
  enabled?: boolean;
  skill_id: string;
  agent_id?: string;
  trigger?: ChannelTriggerConfig;
  config?: Record<string, unknown>;
};

export type ChannelConfigDocument = {
  version: 1;
  channels: ChannelConfig[];
};

export type ChannelMessage = {
  channelId: string;
  externalChatId: string;
  externalMessageId: string;
  text: string;
  ts: string;
  userId?: string;
  userName?: string;
  isBot?: boolean;
  isDirect?: boolean;
  mentionsBot?: boolean;
  threadTs?: string;
  raw?: unknown;
};

export type ChannelSend = {
  channelId: string;
  externalChatId: string;
  text: string;
  threadTs?: string;
};

export type ChannelAdapter = {
  start: (args: { onMessage: (msg: ChannelMessage) => void }) => Promise<void>;
  stop: () => Promise<void>;
  sendMessage: (msg: ChannelSend) => Promise<void>;
  isConnected: () => boolean;
};

export type ChannelFactory = (args: {
  channelId: string;
  config: ChannelConfig;
  logger?: ChannelLogger;
}) => Promise<ChannelAdapter> | ChannelAdapter;

export type ChannelLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
