// Drives the real bot with fake Telegram updates. No network: every Bot API call
// is answered by a stub that records it.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InputFile } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createBot, MAX_CHARS } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { openStore } from "../src/db.ts";
import { saltedHash } from "../src/hash.ts";
import { inspectCapsule } from "../src/lock.ts";
import { stdoutLog } from "../src/log.ts";

const PARTS = [
  "Dear Asha, three weeks ago you arrived in Mandrem saying you wanted to finish the novel about your grandmother's tea estate.",
  "You told me that by December you would send the first fifty pages to Meera, and that you would stop rewriting chapter one.",
  "Three questions for October 2027: Did Meera read it? What did you cut? Who sat with you on the beach that last night? Juniper",
];
const LETTER = PARTS.join("\n\n");

const USER = { id: 4242, is_bot: false, first_name: "Asha" };
const CHAT = { id: 4242, type: "private" as const, first_name: "Asha" };
const AGENT = { id: 777, is_bot: true, first_name: "Juniper", username: "juniper_village_bot" };
const BOT_INFO = {
  id: 1, is_bot: true, first_name: "Dear Me", username: "dear_me_test_bot", can_join_groups: false,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  can_manage_bots: false, supports_join_request_queries: false,
} as UserFromGetMe;

type Call = { method: string; payload: Record<string, any>; result: unknown };

function harness(log = stdoutLog) {
  const dir = mkdtempSync(join(tmpdir(), "dear-me-test-"));
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:TEST", HASH_SALT: "test-salt", DB_PATH: join(dir, "test.db"),
    PUBLIC_BASE_URL: "https://dear-me.test", ADMIN_TG_IDS: String(USER.id),
  });
  const store = openStore(cfg.dbPath);
  const bot = createBot(cfg, store, log, { botInfo: BOT_INFO });
  const calls: Call[] = [];
  let nextMessageId = 5000;
  bot.api.config.use(async (_prev, method, payload) => {
    const result = method.startsWith("send") ? { message_id: nextMessageId++, date: 0, chat: CHAT } : true;
    calls.push({ method, payload: payload as Record<string, any>, result });
    return { ok: true, result } as never;
  });

  let updateId = 0;
  let messageId = 0;
  const feed = (u: object) => bot.handleUpdate({ update_id: ++updateId, ...u } as Update);
  const message = (fields: object) => {
    messageId++;
    return feed({ message: { message_id: messageId, date: 1_700_000_000, chat: CHAT, from: USER, ...fields } });
  };
  return {
    cfg, store, calls, dir,
    owner: saltedHash(cfg.hashSalt, "owner", USER.id),
    lastMessageId: () => messageId,
    command: (text: string) => message({ text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] }),
    typed: (text: string) => message({ text }),
    forward: (text: string, sender = AGENT) =>
      message({ text, forward_origin: { type: "user", date: 1_700_000_000, sender_user: sender } }),
    press: (data: string) =>
      feed({ callback_query: { id: `cb${updateId}`, from: USER, chat_instance: "1", data, message: { message_id: 1, date: 0, chat: CHAT } } }),
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string),
  };
}

async function agree(h: ReturnType<typeof harness>) {
  await h.command("/start");
  await h.press("consent");
}

test("a full session seals the letter, cleans up the chat, and persists no plaintext", async () => {
  const printed: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) console[k] = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  const h = harness();
  try {
    await h.command("/start");
    const start = h.calls.at(-1)!;
    assert.match(start.payload.text, /Nobody can open it before then: not you, not us\./);
    assert.match(start.payload.text, /anyone holding your capsule file or link can open it\. Keep them private\./);
    assert.match(start.payload.text, /Never its text, never your name\./);
    assert.match(start.payload.text, /\/burn/);
    assert.equal(start.payload.reply_markup.inline_keyboard[0][0].text, "I agree");

    await h.press("consent");
    assert.equal(h.store.hasConsent(h.owner), true);
    const prompt = h.sent().find((t) => t.startsWith("<pre>"))!;
    assert.ok(prompt.includes("This is a one-off writing task."));
    assert.ok(prompt.includes("Send this to your Agent Village agent in your private chat. When it replies, forward the reply here."));

    const partIds: number[] = [];
    for (const part of PARTS) {
      await h.forward(part);
      partIds.push(h.lastMessageId());
    }
    assert.equal(h.sent().filter((t) => t.includes("wait 90 seconds")).length, 1, "one acknowledgement per letter");

    await h.press("flush");
    const previewCall = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    const preview = previewCall.payload.text as string;
    assert.ok(preview.includes(LETTER.slice(0, 80)), "preview shows the opening");
    assert.ok(!preview.includes(LETTER.slice(80, 100)), "preview shows at most ~80 characters");
    assert.ok(preview.includes(`${LETTER.length.toLocaleString("en")} characters · 3 parts · Written by an agent`));
    const buttons = previewCall.payload.reply_markup.inline_keyboard[0].map((b: { text: string }) => b.text);
    assert.deepEqual(buttons, ["Seal until 31 Oct 2027", "Cancel"]);

    await h.press("seal");
    const [capsule] = h.store.listMine(h.owner);
    assert.equal(capsule.kind, "resident");
    assert.equal(capsule.source, "agent");
    assert.equal(capsule.agent_hash, saltedHash(h.cfg.hashSalt, "agent", "juniper_village_bot"));
    assert.equal(capsule.round, 44063212);
    assert.deepEqual(inspectCapsule(capsule.ciphertext)?.round, 44063212);

    const deleted = h.calls.find((c) => c.method === "deleteMessages")!;
    const previewId = (previewCall.result as { message_id: number }).message_id;
    assert.deepEqual(deleted.payload.message_ids, [...partIds, previewId], "forwarded parts and preview are deleted");
    assert.ok(h.sent().some((t) => t.includes(`https://dear-me.test/c/${capsule.id}`) && t.includes("still exists in your agent's chat")));
    const docs = h.calls.filter((c) => c.method === "sendDocument").map((c) => c.payload.document as InputFile);
    assert.deepEqual(docs.map((d) => d.filename), [`dear-me-${capsule.id}.age`, "dear-me-opens.ics"]);
    const [age, ics] = await Promise.all(docs.map(async (d) => Buffer.from((await d.toRaw()) as Uint8Array).toString("utf8")));
    assert.equal(age, capsule.ciphertext);
    assert.match(ics, /DTSTART:20271031T143000Z/);
    assert.ok(ics.replace(/\r\n /g, "").includes(`https://dear-me.test/c/${capsule.id}`));

    // Pressing Seal again finds nothing: the plaintext is gone from memory.
    await h.press("seal");
    assert.equal(h.calls.at(-1)!.payload.text, "This preview expired. Forward the letter again.");

    // No 20-character piece of the letter in the database files or in anything printed.
    const files = ["test.db", "test.db-wal", "test.db-shm"].map((f) => join(h.dir, f)).filter(existsSync);
    const haystacks = [...files.map((f) => readFileSync(f)), Buffer.from(printed.join("\n"))];
    assert.ok(Buffer.concat(haystacks).includes(capsule.ciphertext.slice(40, 100)), "the check reads the stored data");
    assert.ok(printed.some((line) => line.includes('"event":"sealed"')), "the check sees the log output");
    for (let i = 0; i + 20 <= LETTER.length; i++) {
      const piece = Buffer.from(LETTER.slice(i, i + 20), "utf8");
      for (const hay of haystacks) assert.ok(!hay.includes(piece), `plaintext found: "${LETTER.slice(i, i + 20)}"`);
    }
  } finally {
    Object.assign(console, saved);
    h.store.close();
  }
});

test("before consent nothing is collected", async () => {
  const h = harness(() => {});
  await h.forward(PARTS[0]);
  assert.match(h.sent().at(-1)!, /please read this and tap I agree/);
  assert.equal(h.calls.some((c) => c.payload.text?.includes("wait 90 seconds")), false);
  h.store.close();
});

test("a typed letter is labelled as written by the resident, and Cancel stores nothing", async () => {
  const h = harness(() => {});
  await agree(h);
  await h.typed("Dear me, a note I wrote myself.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /1 part · Written by the resident/);
  await h.press("cancel");
  assert.match(h.sent().at(-1)!, /Cancelled\. Nothing was stored\./);
  assert.equal(h.store.listMine(h.owner).length, 0);
  h.store.close();
});

test("letters over 4,000 characters are refused", async () => {
  const h = harness(() => {});
  await agree(h);
  await h.forward("x".repeat(MAX_CHARS - 10));
  await h.forward("y".repeat(20));
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /The limit is 4,000/);
  await h.press("seal");
  assert.equal(h.store.listMine(h.owner).length, 0);
  h.store.close();
});

test("at most 3 letters per day; demo capsules don't count", async () => {
  const h = harness(() => {});
  await agree(h);
  await h.command("/demo_seed");
  assert.match(h.sent().at(-1)!, /Created 4 demo capsules/);
  for (let i = 0; i < 3; i++) {
    await h.forward(`Letter number ${i}`);
    await h.press("flush");
    await h.press("seal");
  }
  assert.equal(h.store.listMine(h.owner).filter((c) => c.kind === "resident").length, 3);
  await h.forward("Letter number 4");
  assert.match(h.sent().at(-1)!, /which is the limit/);
  h.store.close();
});

test("/village seals the next letter as ODIN's, and /burn deletes our copy", async () => {
  const h = harness(() => {});
  await agree(h);
  await h.command("/village");
  await h.forward("To the village, in verse.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /ODIN's letter to the village/);
  await h.press("seal");
  const [odin] = h.store.listMine(h.owner);
  assert.equal(odin.kind, "village");

  await h.command("/mine");
  assert.ok(h.sent().at(-1)!.includes(`https://dear-me.test/c/${odin.id}`));
  await h.command(`/burn ${odin.id}`);
  assert.match(h.sent().at(-1)!, /Deleted our copy/);
  assert.equal(h.store.listMine(h.owner).length, 0);
  assert.equal(h.store.getCapsule(odin.id)?.ciphertext, "");
  h.store.close();
});
