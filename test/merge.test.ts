import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createMergeWindow, MERGE_WINDOW_MS, mergeText } from "../src/merge.ts";

test("three parts within 90 seconds become one letter, in order", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const letters: string[] = [];
    const w = createMergeWindow<{ messageId: number; text: string }>(MERGE_WINDOW_MS, (_chat, parts) => {
      letters.push(mergeText(parts));
    });

    assert.equal(w.add(1, { messageId: 10, text: "Dear Asha," }), true);
    mock.timers.tick(30_000);
    // Telegram can deliver a later part first; message ids keep the order.
    assert.equal(w.add(1, { messageId: 12, text: "Juniper" }), false);
    mock.timers.tick(59_000);
    assert.equal(w.add(1, { messageId: 11, text: "You came here to build." }), false);
    assert.deepEqual(letters, []);

    mock.timers.tick(1_000); // 90 s after the first part
    assert.deepEqual(letters, ["Dear Asha,\n\nYou came here to build.\n\nJuniper"]);

    // The next message starts a new letter.
    assert.equal(w.add(1, { messageId: 20, text: "P.S." }), true);
    mock.timers.tick(MERGE_WINDOW_MS);
    assert.deepEqual(letters.at(-1), "P.S.");
  } finally {
    mock.timers.reset();
  }
});

test("windows are per chat, and can be closed early or discarded", async () => {
  const closed: number[] = [];
  const w = createMergeWindow<{ messageId: number; text: string }>(MERGE_WINDOW_MS, (chat) => {
    closed.push(chat);
  });
  w.add(1, { messageId: 1, text: "a" });
  w.add(2, { messageId: 1, text: "b" });
  await w.close(2);
  w.discard(1);
  assert.deepEqual(closed, [2]);
  assert.equal(w.isOpen(1), false);
});
