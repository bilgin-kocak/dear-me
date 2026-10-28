import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { openStore } from "../src/db.ts";
import { saltedHash } from "../src/hash.ts";
import { sealCapsule } from "../src/seal.ts";
import { createWeb } from "../src/web.ts";

const LETTER = "Dear Asha, you came to Mandrem to finish the book you started in March.";

test("/api/wall returns counts and timestamps, never text, ciphertext or capsule links", async () => {
  const cfg = loadConfig({ HASH_SALT: "test-salt" });
  const store = openStore(":memory:");
  const owner = (n: number) => saltedHash(cfg.hashSalt, "owner", n);
  const agent = saltedHash(cfg.hashSalt, "agent", "shared_village_bot");
  const base = { text: LETTER, round: cfg.round, source: "agent" as const, agentHash: agent };
  const sealed = [
    await sealCapsule(store, { ...base, kind: "resident", ownerHash: owner(1) }),
    await sealCapsule(store, { ...base, kind: "resident", ownerHash: owner(2) }),
    await sealCapsule(store, { ...base, kind: "resident", ownerHash: owner(3), source: "resident", agentHash: null }),
    await sealCapsule(store, { ...base, kind: "village", ownerHash: owner(1) }),
    await sealCapsule(store, { ...base, kind: "demo", ownerHash: owner(1) }),
  ];
  const burned = await sealCapsule(store, { ...base, kind: "resident", ownerHash: owner(4) });
  assert.equal(store.burn(burned.id, owner(4)), true);

  const res = await createWeb(cfg, store).request("/api/wall");
  assert.equal(res.status, 200);
  const body = await res.text();
  const wall = JSON.parse(body);

  assert.deepEqual(Object.keys(wall).sort(), ["capsules", "demoCount", "realCount", "uniqueAgents", "unlockAt"]);
  for (const c of wall.capsules) assert.deepEqual(Object.keys(c).sort(), ["id", "kind", "sealedAt", "unlockAt"]);
  assert.equal(wall.realCount, 4); // 3 residents + ODIN, no demo, no burned
  assert.equal(wall.demoCount, 1);
  assert.equal(wall.uniqueAgents, 2); // one shared bot, two residents' agents
  assert.equal(wall.unlockAt, "2027-10-31T14:30:00.000Z");
  assert.equal(wall.capsules.length, 5);

  for (const c of [...sealed, burned]) {
    assert.ok(!body.includes(c.id), "a capsule link id leaked onto the wall");
    assert.ok(!body.includes(c.ciphertext.slice(40, 80)), "ciphertext leaked onto the wall");
  }
  assert.ok(!body.includes("Asha") && !body.includes("Mandrem"));
  assert.ok(!/text|ciphertext|owner|agent_hash|source/i.test(Object.keys(wall.capsules[0]).join()));
});

test("/api/c/:id serves the ciphertext, and nothing after a burn", async () => {
  const cfg = loadConfig({ HASH_SALT: "test-salt" });
  const store = openStore(":memory:");
  const owner = saltedHash(cfg.hashSalt, "owner", 1);
  const c = await sealCapsule(store, { text: LETTER, kind: "resident", round: cfg.round, ownerHash: owner, agentHash: null, source: "resident" });
  const app = createWeb(cfg, store);

  const ok = await (await app.request(`/api/c/${c.id}`)).json();
  assert.equal(ok.ciphertext, c.ciphertext);
  assert.equal(ok.round, 44063212);
  assert.equal((await app.request("/api/c/nope")).status, 404);

  assert.equal(store.burn(c.id, saltedHash(cfg.hashSalt, "owner", 2)), false, "only the owner can burn");
  assert.equal(store.burn(c.id, owner), true);
  const gone = await app.request(`/api/c/${c.id}`);
  assert.equal(gone.status, 410);
  assert.ok(!(await gone.text()).includes("AGE ENCRYPTED"));
});
