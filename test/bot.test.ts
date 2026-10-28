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
import { sealCapsule } from "../src/seal.ts";
import { stdoutLog, type Log } from "../src/log.ts";

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

function harness({ log = stdoutLog as Log, admin = true, env = {} as Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dear-me-test-"));
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:TEST", HASH_SALT: "test-salt-for-the-bot", DB_PATH: join(dir, "test.db"),
    PUBLIC_BASE_URL: "https://dear-me.test", ADMIN_TG_IDS: admin ? String(USER.id) : "", ...env,
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
  /** The id of the newest bot message carrying a button with this callback data. */
  const withButton = (data: string) => {
    const call = [...calls].reverse().find((c) => c.method === "sendMessage" && JSON.stringify(c.payload.reply_markup ?? {}).includes(`"callback_data":"${data}"`));
    return (call?.result as { message_id: number } | undefined)?.message_id ?? 1;
  };

  let updateId = 0;
  let messageId = 0;
  const feed = (u: object) => bot.handleUpdate({ update_id: ++updateId, ...u } as Update);
  const message = (fields: object) => {
    messageId++;
    return feed({ message: { message_id: messageId, date: 1_700_000_000, chat: CHAT, from: USER, ...fields } });
  };
  const fromAgent = { forward_origin: { type: "user", date: 1_700_000_000, sender_user: AGENT } };
  return {
    cfg, store, calls, dir,
    owner: saltedHash(cfg.hashSalt, "owner", USER.id),
    lastMessageId: () => messageId,
    previewId: () => withButton("seal"),
    command: (text: string) => message({ text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] }),
    typed: (text: string) => message({ text }),
    /** date: when the agent originally sent it (parts of one reply are seconds apart). */
    forward: (text: string, sender = AGENT, date = 1_700_000_000) =>
      message({ text, forward_origin: { type: "user", date, sender_user: sender } }),
    album: (group: string, caption?: string, forwarded = true) =>
      message({ media_group_id: group, photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }], ...(caption ? { caption } : {}), ...(forwarded ? fromAgent : {}) }),
    edit: (id: number, text: string) =>
      feed({ edited_message: { message_id: id, date: 1_700_000_000, edit_date: 1_700_000_100, chat: CHAT, from: USER, text } }),
    /** Taps a button on the newest bot message that has it (the preview, the acknowledgement…). */
    press: (data: string, onMessage = withButton(data)) =>
      feed({ callback_query: { id: `cb${updateId}`, from: USER, chat_instance: "1", data, message: { message_id: onMessage, date: 0, chat: CHAT } } }),
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string),
    answers: () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text as string | undefined),
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
    await h.press("seal", previewId);
    assert.equal(h.answers().at(-1), "This preview is no longer active. Forward the letter again.");
    assert.equal(h.store.listMine(h.owner).length, 1);

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


const quiet = { log: () => {} };

test("before consent nothing is collected", async () => {
  const h = harness(quiet);
  await h.forward(PARTS[0]);
  assert.match(h.sent().at(-1)!, /please read this and tap I agree/);
  assert.equal(h.calls.some((c) => c.payload.text?.includes("wait 90 seconds")), false);
  h.store.close();
});

test("a typed letter is labelled as the resident's, and Cancel stores nothing", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.typed("Dear me, a note I wrote myself.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /1 part · Written by the resident/);
  await h.press("cancel");
  assert.match(h.sent().at(-1)!, /Cancelled\. Nothing was stored\./);
  assert.equal(h.store.listMine(h.owner).length, 0);
  h.store.close();
});

test("a typed letter is sealed but left in the chat, and the reply says so", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.typed("Dear me, a note I wrote myself.");
  await h.press("flush");
  const previewId = h.previewId();
  await h.press("seal");
  assert.equal(h.store.listMine(h.owner)[0].source, "resident");
  assert.deepEqual(h.calls.find((c) => c.method === "deleteMessages")!.payload.message_ids, [previewId]);
  const sealed = h.sent().find((t) => t.startsWith("<b>Sealed</b>"))!;
  assert.match(sealed, /What you typed is still here/);
  assert.doesNotMatch(sealed, /agent's chat/);
  h.store.close();
});

test("letters over 4,000 characters are refused", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward("x".repeat(MAX_CHARS - 10));
  await h.forward("y".repeat(20));
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /The limit is 4,000/);
  await h.press("seal");
  assert.equal(h.store.listMine(h.owner).length, 0);
  h.store.close();
});

test("the same part forwarded twice is counted once", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward(PARTS[0]);
  await h.forward(PARTS[0]);
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /1 part · Written by an agent/);
  h.store.close();
});

test("after a preview, typed text is not merged and a new forward starts a new letter", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward("Letter A from the agent.");
  await h.press("flush");
  const previewA = h.previewId();
  await h.typed("ok seal it");
  assert.equal(h.sent().at(-1), "Tap Seal or Cancel on the preview above first.");

  await h.forward("Letter B from the agent.", AGENT, 1_700_000_300); // a new reply, minutes later
  assert.match(h.sent().at(-1)!, /^That starts a new letter, so I discarded the previous preview\./);
  assert.ok(h.calls.some((c) => c.method === "deleteMessage" && c.payload.message_id === previewA), "old preview removed");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /1 part · Written by an agent/);

  // A's old Seal button must not seal B.
  await h.press("seal", previewA);
  assert.equal(h.answers().at(-1), "This preview is no longer active. Forward the letter again.");
  assert.equal(h.store.listMine(h.owner).length, 0);
  await h.press("seal");
  const [capsule] = h.store.listMine(h.owner);
  assert.equal(capsule.source, "agent");
  h.store.close();
});

test("if sealing fails, nothing is stored and Seal can be tapped again", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward("Dear Asha, a letter.");
  await h.press("flush");
  const insert = h.store.insertCapsule;
  h.store.insertCapsule = () => {
    throw new Error("database or disk is full");
  };
  await h.press("seal");
  assert.match(h.sent().at(-1)!, /sealing failed and nothing was stored/);
  assert.equal(h.calls.some((c) => c.method === "deleteMessages"), false, "nothing deleted after a failure");
  h.store.insertCapsule = insert;
  await h.press("seal");
  assert.equal(h.store.listMine(h.owner).length, 1);
  h.store.close();
});

test("editing a typed part updates the letter and its preview", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.typed("We swam at the beech.");
  const id = h.lastMessageId();
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /21 characters/);
  await h.edit(id, "We swam at the beach, Asha.");
  const edited = h.calls.find((c) => c.method === "editMessageText")!;
  assert.equal(edited.payload.message_id, h.previewId());
  assert.match(edited.payload.text, /beach, Asha\./);
  assert.match(edited.payload.text, /27 characters/);
  h.store.close();
});

test("an album's extra photos are collected quietly and deleted on Seal", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.album("g1", "Dear Asha, the letter is the caption.");
  const ids = [h.lastMessageId()];
  await h.album("g1");
  ids.push(h.lastMessageId());
  await h.album("g1");
  ids.push(h.lastMessageId());
  assert.equal(h.sent().filter((t) => t.includes("I can only seal text")).length, 0);
  await h.press("flush");
  const previewId = h.previewId();
  await h.press("seal");
  assert.deepEqual(h.calls.find((c) => c.method === "deleteMessages")!.payload.message_ids, [...ids, previewId]);
  h.store.close();
});

test("residents may seal 3 letters a day; burned and demo capsules don't count, admins are exempt", async () => {
  const h = harness({ ...quiet, admin: false });
  await agree(h);
  for (let i = 0; i < 3; i++) {
    await sealCapsule(h.store, { text: "demo", kind: "demo", round: h.cfg.round, ownerHash: h.owner, agentHash: null, source: "unverified" });
  }
  for (let i = 0; i < 3; i++) {
    await h.forward(`Letter number ${i}`);
    await h.press("flush");
    await h.press("seal");
  }
  assert.equal(h.store.listMine(h.owner).filter((c) => c.kind === "resident").length, 3, "demo capsules don't use up the limit");
  await h.forward("Letter number 4");
  assert.match(h.sent().at(-1)!, /which is the limit/);
  await h.command(`/burn ${h.store.listMine(h.owner).find((c) => c.kind === "resident")!.id}`);
  await h.forward("Letter number 5");
  assert.match(h.sent().at(-1)!, /I'll wait 90 seconds/);
  h.store.close();

  const admin = harness(quiet);
  await agree(admin);
  await admin.command("/demo_seed");
  assert.match(admin.sent().at(-1)!, /Created 4 demo capsules/);
  for (let i = 0; i < 4; i++) {
    await admin.forward(`Letter number ${i}`);
    await admin.press("flush");
    await admin.press("seal");
  }
  assert.equal(admin.store.listMine(admin.owner).filter((c) => c.kind === "resident").length, 4);
  admin.store.close();
});

test("/village drops the letter in progress; only the next forward becomes ODIN's; /burn deletes our copy", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward("The admin's own letter.");
  await h.press("flush");
  await h.command("/village");
  assert.match(h.sent().at(-1)!, /^I discarded the letter in progress\. Forward ODIN's letter now/);

  await h.typed("A note typed in between.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /^<b>Preview<\/b>/, "a typed note does not use up /village");
  await h.press("cancel");

  await h.forward("To the village, in verse.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /^<b>ODIN's letter to the village<\/b>/);
  await h.press("seal");
  const [odin] = h.store.listMine(h.owner);
  assert.equal(odin.kind, "village");

  await h.forward("The admin's next letter.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /^<b>Preview<\/b>/, "the flag is used up");

  await h.command("/mine");
  assert.ok(h.sent().at(-1)!.includes(`https://dear-me.test/c/${odin.id}`));
  await h.command(`/burn ${odin.id}`);
  assert.match(h.sent().at(-1)!, /Deleted our copy/);
  assert.equal(h.store.listMine(h.owner).length, 0);
  assert.equal(h.store.getCapsule(odin.id)?.ciphertext, "");
  h.store.close();
});

test("/mine sends long lists in pages", async () => {
  const h = harness(quiet);
  await agree(h);
  for (let i = 0; i < 3; i++) await h.command("/demo_seed");
  const before = h.sent().length;
  await h.command("/mine");
  const pages = h.sent().slice(before);
  assert.equal(pages.length, 2);
  assert.ok(pages.every((p) => p.length < 4096));
  assert.equal(pages.join("\n").match(/\/burn /g)?.length, 12);
  h.store.close();
});

test("'That's everything' with nothing waiting (after a restart) says so", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.press("flush", 4242);
  assert.match(h.sent().at(-1)!, /Nothing is waiting any more/);
  h.store.close();
});

test("after the unlock time the bot stops sealing", async () => {
  const h = harness({ ...quiet, env: { UNLOCK_AT: "2025-01-01T00:00:00Z" } });
  await h.command("/start");
  assert.match(h.sent().at(-1)!, /^Sealing closed/);
  await h.forward("A letter for a year that has passed.");
  assert.match(h.sent().at(-1)!, /^Sealing closed/);
  assert.equal(h.store.listMine(h.owner).length, 0);
  h.store.close();
});

test("a late part of the same reply goes back into its letter, in order", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward(PARTS[0]);
  await h.forward(PARTS[1]);
  await h.press("flush");
  await h.forward(PARTS[2], AGENT, 1_700_000_002); // the straggler, sent two seconds later
  assert.match(h.sent().at(-1)!, /^Added that to the letter\./);
  await h.press("flush");
  const preview = h.sent().at(-1)!;
  assert.ok(preview.includes(PARTS[0].slice(0, 60)), "the letter still starts with part one");
  assert.match(preview, /3 parts · Written by an agent/);
  h.store.close();
});

test("a duplicate forward is deleted on Seal with the rest", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward(PARTS[0]);
  const first = h.lastMessageId();
  await h.forward(PARTS[0]);
  const copy = h.lastMessageId();
  await h.press("flush");
  const previewId = h.previewId();
  await h.press("seal");
  assert.deepEqual(h.calls.find((c) => c.method === "deleteMessages")!.payload.message_ids, [first, copy, previewId]);
  h.store.close();
});

test("ODIN's forward joining a note typed after /village makes it ODIN's letter", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.command("/village");
  await h.typed("Here is ODIN's verse:");
  await h.forward("To the village, in verse.");
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /^<b>ODIN's letter to the village<\/b>/);
  await h.press("seal");
  assert.equal(h.store.listMine(h.owner)[0].kind, "village");
  await h.forward("The admin's own letter.", AGENT, 1_700_000_600);
  await h.press("flush");
  assert.match(h.sent().at(-1)!, /^<b>Preview<\/b>/, "the flag is used up");
  h.store.close();
});

test("album photos that arrive before the caption join the letter, and the text-only notice goes", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.album("g2");
  const ids = [h.lastMessageId()];
  const notice = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
  assert.equal(notice.payload.text, "I can only seal text. Forward your agent's text reply.");
  await h.album("g2");
  ids.push(h.lastMessageId());
  await h.album("g2", "Dear Asha, the caption came last.");
  ids.push(h.lastMessageId());
  const noticeId = (notice.result as { message_id: number }).message_id;
  assert.ok(h.calls.some((c) => c.method === "deleteMessage" && c.payload.message_id === noticeId), "notice removed");
  await h.press("flush");
  const previewId = h.previewId();
  await h.press("seal");
  assert.deepEqual(new Set(h.calls.find((c) => c.method === "deleteMessages")!.payload.message_ids), new Set([...ids, previewId]));
  h.store.close();
});

test("the resident's own album photos are never deleted", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.album("g3", "Dear me, my own photo album.", false);
  await h.album("g3", undefined, false);
  await h.press("flush");
  const previewId = h.previewId();
  await h.press("seal");
  assert.deepEqual(h.calls.find((c) => c.method === "deleteMessages")!.payload.message_ids, [previewId]);
  h.store.close();
});

test("a second tap on 'That's everything' after a too-long letter stays quiet", async () => {
  const h = harness(quiet);
  await agree(h);
  await h.forward("z".repeat(MAX_CHARS + 100));
  const ack = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
  const ackId = (ack.result as { message_id: number }).message_id;
  await h.press("flush", ackId);
  assert.match(h.sent().at(-1)!, /The limit is 4,000/);
  await h.press("flush", ackId);
  assert.match(h.sent().at(-1)!, /The limit is 4,000/, "no restart message");
  h.store.close();
});
