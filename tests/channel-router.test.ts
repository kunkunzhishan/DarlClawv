import test from "node:test";
import assert from "node:assert/strict";
import { shouldHandleMessage } from "../src/channels/router.js";
import type { ChannelMessage } from "../src/channels/types.js";

function baseMessage(overrides: Partial<ChannelMessage>): ChannelMessage {
  return {
    channelId: "slack-default",
    externalChatId: "C123",
    externalMessageId: "m1",
    text: "hello",
    ts: new Date().toISOString(),
    ...overrides
  };
}

test("shouldHandleMessage allows direct messages", () => {
  const msg = baseMessage({ isDirect: true });
  const decision = shouldHandleMessage(msg, { mode: "mention-or-prefix", prefix: "claw " });
  assert.equal(decision.allowed, true);
});

test("shouldHandleMessage respects mention trigger", () => {
  const msg = baseMessage({ isDirect: false, mentionsBot: true });
  const decision = shouldHandleMessage(msg, { mode: "mention" });
  assert.equal(decision.allowed, true);
});

test("shouldHandleMessage respects prefix trigger", () => {
  const msg = baseMessage({ isDirect: false, text: "claw do it" });
  const decision = shouldHandleMessage(msg, { mode: "prefix", prefix: "claw " });
  assert.equal(decision.allowed, true);
  assert.equal(decision.cleanedText, "do it");
});

test("shouldHandleMessage ignores bot messages", () => {
  const msg = baseMessage({ isBot: true });
  const decision = shouldHandleMessage(msg, { mode: "direct" });
  assert.equal(decision.allowed, false);
});
