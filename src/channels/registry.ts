import type { ChannelFactory } from "./types.js";

const channelRegistry = new Map<string, ChannelFactory>();

export function registerChannel(kind: string, factory: ChannelFactory): void {
  if (!kind || !factory) {
    return;
  }
  channelRegistry.set(kind, factory);
}

export function getChannelFactory(kind: string): ChannelFactory | undefined {
  return channelRegistry.get(kind);
}

export function listChannelKinds(): string[] {
  return [...channelRegistry.keys()].sort();
}
