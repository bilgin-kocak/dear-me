// Talks to the real drand network. Skip with SKIP_NETWORK=1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mainnetClient, timelockDecrypt } from "tlock-js";
import { isTooEarly, open, roundIn, seal, timeOfRound } from "../src/lock.ts";
import { openWhenDue } from "../web/opener.ts";

test("hello sealed for ~9 seconds fails early, then opens", { skip: process.env.SKIP_NETWORK === "1", timeout: 60_000 }, async () => {
  const round = roundIn(9);
  const armored = await seal("hello", round);

  await assert.rejects(open(armored), (err) => isTooEarly(err) && /decryptable at round \d+/.test((err as Error).message));

  await new Promise((r) => setTimeout(r, timeOfRound(round) - Date.now()));
  let plain: string | undefined;
  for (let attempt = 0; attempt < 20 && plain === undefined; attempt++) {
    try {
      plain = await open(armored);
    } catch {
      await new Promise((r) => setTimeout(r, 1000)); // the beacon can lag its round time by a moment
    }
  }
  assert.equal(plain, "hello");
  // The capsule is plain tlock: the stock tlock-js mainnet client opens it too.
  assert.equal((await timelockDecrypt(armored, mainnetClient())).toString("utf8"), "hello");
});

test("a damaged capsule for a published round fails at once instead of waiting forever", { skip: process.env.SKIP_NETWORK === "1", timeout: 30_000 }, async () => {
  const round = roundIn(-60); // published a minute ago
  const armored = await seal("hello", round);
  const lines = armored.split("\n");
  const last = lines.length - 3; // a payload line, well past the header
  lines[last] = (lines[last][0] === "A" ? "B" : "A") + lines[last].slice(1);
  assert.equal(await openWhenDue(armored, round), "hello");
  await assert.rejects(openWhenDue(lines.join("\n"), round), (err) => !isTooEarly(err));
});
