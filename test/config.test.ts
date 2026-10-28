import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("UNLOCK_AT must carry a timezone offset", () => {
  assert.throws(() => loadConfig({ UNLOCK_AT: "2027-10-31T20:00:00" }), /timezone offset/);
  assert.equal(loadConfig({ UNLOCK_AT: "2027-10-31T14:30:00Z" }).round, 44063212);
  assert.equal(loadConfig({ UNLOCK_AT: "2027-10-31T20:00:00+0530" }).round, 44063212);
});

test("the bot refuses a missing, short or placeholder HASH_SALT", () => {
  const bot = { TELEGRAM_BOT_TOKEN: "123:TEST" };
  assert.throws(() => loadConfig(bot), /HASH_SALT/);
  assert.throws(() => loadConfig({ ...bot, HASH_SALT: "short" }), /HASH_SALT/);
  assert.throws(() => loadConfig({ ...bot, HASH_SALT: "replace-with-output-of-openssl-rand-base64-32" }), /HASH_SALT/);
  assert.equal(loadConfig({ ...bot, HASH_SALT: "a-long-random-secret-value" }).hashSalt, "a-long-random-secret-value");
  assert.equal(loadConfig({}).hashSalt, "dev-only-salt", "web-only runs need no salt");
});
