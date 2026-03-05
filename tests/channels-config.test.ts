import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChannelsConfig } from "../src/channels/config.js";

test("normalizeChannelsConfig filters invalid entries and defaults", () => {
  const doc = normalizeChannelsConfig({
    channels: [
      { id: "slack-default", kind: "slack", skill_id: "channel-slack" },
      { id: "", kind: "slack", skill_id: "missing" }
    ]
  });

  assert.equal(doc.channels.length, 1);
  assert.equal(doc.channels[0]?.id, "slack-default");
  assert.equal(doc.channels[0]?.enabled, true);
});
