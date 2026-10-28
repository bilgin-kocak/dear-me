import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultChainInfo, roundAt, roundTime } from "tlock-js";
import { loadConfig } from "../src/config.ts";
import { CHAIN, inspectCapsule, roundForUnlock, seal, timeOfRound } from "../src/lock.ts";

const UNLOCK = "2027-10-31T20:00:00+05:30";

test("the unlock time is drand quicknet round 44063212, published 2027-10-31T14:30:00Z", () => {
  const round = roundAt(Date.parse(UNLOCK), defaultChainInfo);
  assert.equal(round, 44063212);
  assert.equal(new Date(roundTime(defaultChainInfo, round)).toISOString(), "2027-10-31T14:30:00.000Z");
  assert.equal(loadConfig({ UNLOCK_AT: UNLOCK }).round, 44063212);
});

test("the pinned chain is quicknet", () => {
  assert.equal(CHAIN.hash, "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971");
  assert.equal(CHAIN.period, 3);
  assert.equal(CHAIN.genesis_time, 1692803367);
});

test("an unlock time between rounds rounds up, never down", () => {
  const boundary = timeOfRound(44063212);
  assert.equal(roundForUnlock(boundary), 44063212);
  assert.equal(roundForUnlock(boundary + 1), 44063213);
  assert.ok(timeOfRound(roundForUnlock(boundary + 2999)) >= boundary + 2999);
});

test("sealing works offline and the capsule names its round and chain", async () => {
  const armored = await seal("hello", 44063212);
  assert.match(armored, /^-----BEGIN AGE ENCRYPTED FILE-----/);
  assert.deepEqual(inspectCapsule(armored), { round: 44063212, chainHash: CHAIN.hash });
  assert.equal(inspectCapsule("not a capsule"), null);
});
