// The seal link's server side: config for the pages, storing browser-sealed capsules, deleting them.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, MAX_CHARS } from "../src/config.ts";
import { openStore } from "../src/db.ts";
import { saltedHash } from "../src/hash.ts";
import { canonicalCapsule, inspectCapsule, roundIn, seal } from "../src/lock.ts";
import { sealCapsule } from "../src/seal.ts";
import { createWeb } from "../src/web.ts";

const LETTER = "Dear Asha, you came to Mandrem to finish the book you started in March. Juniper";

function setup(env: Record<string, string> = {}, limits = { perIp: 30, total: 600 }) {
  const cfg = loadConfig({ HASH_SALT: "test-salt-for-the-web", PUBLIC_BASE_URL: "https://dear-me.test", ...env });
  const store = openStore(":memory:");
  const logged: string[] = [];
  const app = createWeb(cfg, store, { limits, log: (event, fields) => void logged.push(JSON.stringify({ event, ...fields })) });
  const post = (body: unknown, ip = "203.0.113.7") =>
    app.request("/api/capsules", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Fly-Client-IP": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { cfg, store, app, post, logged };
}

test("/api/config gives the pages the round, the limit and the bot", async () => {
  const { app, cfg } = setup();
  const res = await app.request("/api/config");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), { unlockAt: "2027-10-31T14:30:00.000Z", round: 44063212, maxChars: MAX_CHARS, bot: null });
  cfg.botUsername = "dear_me_bot";
  assert.equal((await (await app.request("/api/config")).json()).bot, "dear_me_bot");
});

test("a capsule sealed in the browser is stored as a link capsule and counted on the wall", async () => {
  const { app, post, store, logged } = setup();
  const armored = await seal(LETTER, 44063212);
  const res = await post({ ciphertext: armored });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["id", "round", "unlockAt", "url"]);
  assert.equal(body.url, `https://dear-me.test/c/${body.id}`);

  const cap = store.getCapsule(body.id)!;
  assert.equal(cap.kind, "resident");
  assert.equal(cap.source, "link");
  assert.equal(cap.agent_hash, null);
  assert.equal(cap.ciphertext, canonicalCapsule(armored));
  const served = await (await app.request(`/api/c/${body.id}`)).json();
  assert.equal(served.source, "link");

  const wall = await (await app.request("/api/wall")).json();
  assert.equal(wall.realCount, 1);
  assert.equal(wall.uniqueAgents, 1, "a link letter counts as one agent");
  assert.ok(!JSON.stringify(wall).includes(body.id));
  assert.deepEqual(logged, [JSON.stringify({ event: "sealed", kind: "resident", source: "link" })]);
});

test("the longest letter fits, in the widest characters", async () => {
  const { post } = setup();
  const armored = await seal("अ".repeat(MAX_CHARS), 44063212); // 3 bytes each in UTF-8
  assert.equal((await post({ ciphertext: armored })).status, 201);
});

test("capsules the server must not keep are refused", async () => {
  const { post, store } = setup();
  const armored = await seal(LETTER, 44063212);
  // The same capsule with another chain's hash in its header.
  const bytes = Buffer.from(armored.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  const chain = inspectCapsule(armored)!.chainHash;
  const otherChain = Buffer.from(bytes.toString("latin1").replace(chain, "f".repeat(64)), "latin1").toString("base64");
  const refused = {
    otherRound: await seal(LETTER, 44063211), // opens 3 seconds early
    openNow: await seal(LETTER, roundIn(-60)),
    otherChain: `-----BEGIN AGE ENCRYPTED FILE-----\n${otherChain}\n-----END AGE ENCRYPTED FILE-----\n`,
    notACapsule: "Dear Asha, this is the letter itself",
    missing: undefined,
    notAString: 42,
  };
  for (const [name, ciphertext] of Object.entries(refused)) assert.equal((await post({ ciphertext })).status, 400, name);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ ciphertext: "x".repeat(40_000) })).status, 413);
  assert.equal(store.wallRows().length, 0);
});

test("sealing is rate limited per address and in total", async () => {
  const { post } = setup({}, { perIp: 2, total: 3 });
  const armored = await seal(LETTER, 44063212);
  assert.equal((await post({ ciphertext: armored }, "198.51.100.1")).status, 201);
  assert.equal((await post({ ciphertext: armored }, "198.51.100.1")).status, 201);
  assert.equal((await post({ ciphertext: armored }, "198.51.100.1")).status, 429, "per address");
  assert.equal((await post({ ciphertext: armored }, "198.51.100.2")).status, 201);
  assert.equal((await post({ ciphertext: armored }, "198.51.100.3")).status, 429, "in total");
});

test("after the unlock time nothing more is sealed", async () => {
  const { post } = setup({ UNLOCK_AT: "2024-01-01T00:00:00Z" });
  assert.equal((await post({ ciphertext: await seal(LETTER, roundIn(-60)) })).status, 410);
});

test("a link capsule's link deletes our copy; a bot capsule can't be deleted from the web", async () => {
  const { app, post, store, cfg } = setup();
  const { id } = await (await post({ ciphertext: await seal(LETTER, 44063212) })).json();
  assert.equal((await app.request(`/api/c/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await app.request(`/api/c/${id}`)).status, 410);
  assert.equal(store.getCapsule(id)!.ciphertext, "");
  assert.equal((await app.request(`/api/c/${id}`, { method: "DELETE" })).status, 404, "already deleted");

  const owner = saltedHash(cfg.hashSalt, "owner", 4242);
  const bot = await sealCapsule(store, { text: LETTER, kind: "resident", round: cfg.round, ownerHash: owner, agentHash: null, source: "resident" });
  assert.equal((await app.request(`/api/c/${bot.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await app.request(`/api/c/${bot.id}`)).status, 200);
});

test("/seal and /ask are served, without a referrer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dear-me-pages-"));
  for (const page of ["seal", "ask"]) writeFileSync(join(dir, `${page}.html`), `<p>${page} page</p>`);
  const app = createWeb(loadConfig({ HASH_SALT: "test-salt-for-the-web" }), openStore(":memory:"), { pagesDir: dir });
  for (const page of ["seal", "ask"]) {
    const res = await app.request(`/${page}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), `<p>${page} page</p>`);
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  }
});
