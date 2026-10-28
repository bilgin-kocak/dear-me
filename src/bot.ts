import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { dateIST, dateTimeIST, type Config } from "./config.ts";
import type { Capsule, Kind, Store } from "./db.ts";
import { saltedHash } from "./hash.ts";
import { calendarFile } from "./ics.ts";
import { roundIn } from "./lock.ts";
import type { Log } from "./log.ts";
import { backgroundTimer, createMergeWindow, MERGE_WINDOW_MS, mergeText } from "./merge.ts";
import { classifyOrigin, combineOrigins, SOURCE_LABEL, type Origin } from "./origin.ts";
import { sealCapsule } from "./seal.ts";
import * as T from "./texts.ts";

export const MAX_CHARS = 4000;
export const MAX_PER_DAY = 3;
const PREVIEW_CHARS = 80;
const PREVIEW_TTL_MS = 30 * 60_000; // an unanswered preview is forgotten after 30 minutes
const MINE_PAGE = 10; // capsules per /mine message, well inside Telegram's 4,096 characters

/** sentAt is when the original was sent (the forward's origin date), in Unix seconds. */
type Part = { messageId: number; text: string; origin: Origin; forwarded: boolean; sentAt: number };
/**
 * A letter being collected while its merge window is open. extraIds are forwarded messages
 * deleted on Seal besides the parts: album photos and duplicate forwards.
 */
type Letter = { kind: Kind; ackId?: number; extraIds: number[] };
/** A collected letter waiting for Seal or Cancel on its preview. */
type Pending = { kind: Kind; extraIds: number[]; parts: Part[]; previewId?: number; expiry?: ReturnType<typeof setTimeout> };
/** Captionless album photos that arrived before the album's caption started a letter. */
type Stray = { group: string; ids: number[]; noticeId?: number };

const TEXT_ONLY = "I can only seal text. Forward your agent's text reply.";
const SAME_REPLY_S = 60; // an agent sends the parts of one reply within seconds of each other

/** A forward that belongs to the same agent reply as these parts: same sender, sent moments apart. */
const sameReply = (parts: Part[], part: Part) =>
  parts.every((x) => x.forwarded && x.origin.source === part.origin.source &&
    x.origin.agentUsername === part.origin.agentUsername && Math.abs(x.sentAt - part.sentAt) <= SAME_REPLY_S);

const KIND_LABEL: Record<Kind, string> = {
  resident: "Letter from your agent",
  village: "ODIN's letter to the village",
  demo: "Demo",
};

/** A resident's capsule is named after who wrote it. */
const capsuleLabel = (c: Pick<Capsule, "kind" | "source">) =>
  c.kind !== "resident" ? KIND_LABEL[c.kind]
    : c.source === "agent" ? KIND_LABEL.resident
      : c.source === "resident" ? "Letter you wrote" : "Sealed letter (unverified)";

const DEMO_LETTER = `Dear Sam,

This is a demo capsule, not a real letter. You came to Edge City India to find out whether the idea on your napkins is a company or a hobby. You said you would ship a first version to ten people by December.

Three questions for October 2027: Did you ship it? Who did you build it with? What would you tell the person who arrived in Mandrem?

Juniper, your agent (sample)`;

export function createBot(
  cfg: Config,
  store: Store,
  log: Log,
  opts: { botInfo?: UserFromGetMe; mergeWindowMs?: number } = {},
) {
  if (!cfg.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const bot = new Bot(cfg.botToken, { botInfo: opts.botInfo });
  const windowMs = opts.mergeWindowMs ?? MERGE_WINDOW_MS;

  // Plaintext lives only in the merge window and in `pending`, and only until Seal, Cancel or expiry.
  const windows = createMergeWindow<Part>(windowMs, (chatId, parts) => showPreview(chatId, parts));
  const collecting = new Map<number, Letter>();
  const pending = new Map<number, Pending>();
  const villageNext = new Set<number>(); // admin chats whose next forwarded letter is ODIN's
  const strays = new Map<number, Stray>(); // chat -> photos of an album whose caption hasn't come yet
  const lastAck = new Map<number, number>(); // chat -> the newest "That's everything" message sent

  const ownerOf = (ctx: Context) => saltedHash(cfg.hashSalt, "owner", ctx.from!.id);
  const isAdmin = (ctx: Context) => cfg.adminIds.has(ctx.from?.id ?? Number.NaN);
  const link = (id: string) => `${cfg.publicBaseUrl}/c/${id}`;
  const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
  const agreeButton = new InlineKeyboard().text("I agree", "consent");
  const previewButtons = new InlineKeyboard().text(`Seal until ${dateIST(cfg.unlockMs)}`, "seal").text("Cancel", "cancel");
  const flushButton = new InlineKeyboard().text("That's everything", "flush");
  // Admins rehearse a lot and seal ODIN's letter, so the limit is for residents.
  const overLimit = (ctx: Context) =>
    !isAdmin(ctx) && store.sealedSince(ownerOf(ctx), new Date(Date.now() - 86_400_000).toISOString()) >= MAX_PER_DAY;
  const limitMessage = `You've sealed ${MAX_PER_DAY} letters in the last 24 hours, which is the limit. Try again tomorrow.`;
  const tooLong = (n: number) =>
    `That letter is ${n.toLocaleString("en")} characters. The limit is ${MAX_CHARS.toLocaleString("en")}, so ask your agent for a shorter one (the prompt asks for under 300 words) and forward it again.`;
  // Once drand has published the unlock round, a letter "sealed" to it would open at once.
  const sealingClosed = () => Date.now() >= cfg.unlockMs;
  const closedMessage = () =>
    `Sealing closed at ${dateTimeIST(cfg.unlockMs)}, when the letters opened. Capsule links and files still work.`;
  const deleteQuietly = (chatId: number, messageId?: number) =>
    messageId ? bot.api.deleteMessage(chatId, messageId).then(() => {}, () => {}) : Promise.resolve();

  /** Keeps a collected letter until Seal or Cancel, or forgets it after PREVIEW_TTL_MS. */
  function hold(chatId: number, p: Pending) {
    clearTimeout(p.expiry);
    pending.set(chatId, p);
    p.expiry = backgroundTimer(() => {
      if (pending.get(chatId) !== p) return;
      pending.delete(chatId);
      log("preview_expired", { parts: p.parts.length });
      void deleteQuietly(chatId, p.previewId);
    }, PREVIEW_TTL_MS);
  }

  function takePending(chatId: number) {
    const p = pending.get(chatId);
    clearTimeout(p?.expiry);
    pending.delete(chatId);
    return p;
  }

  /** Throws away the chat's letter in progress, if any, with its acknowledgement or preview. */
  async function discardLetter(chatId: number) {
    const letter = collecting.get(chatId);
    collecting.delete(chatId);
    windows.discard(chatId);
    const p = takePending(chatId);
    await deleteQuietly(chatId, letter?.ackId);
    await deleteQuietly(chatId, p?.previewId);
    return Boolean(letter || p);
  }

  function previewText(p: Pending) {
    const text = mergeText(p.parts);
    const head = Array.from(text).slice(0, PREVIEW_CHARS).join("");
    const origin = combineOrigins(p.parts.map((x) => x.origin));
    return [
      `<b>${p.kind === "village" ? KIND_LABEL.village : "Preview"}</b>`,
      `<i>${T.esc(head)}${head.length < text.length ? "…" : ""}</i>`,
      "",
      `${text.length.toLocaleString("en")} characters · ${p.parts.length} ${p.parts.length === 1 ? "part" : "parts"} · ${SOURCE_LABEL[origin.source]}`,
    ].join("\n");
  }

  async function showPreview(chatId: number, parts: Part[]) {
    const letter: Letter = collecting.get(chatId) ?? { kind: "resident", extraIds: [] };
    collecting.delete(chatId);
    const length = mergeText(parts).length;
    const p: Pending | undefined = length > MAX_CHARS ? undefined : { kind: letter.kind, extraIds: letter.extraIds, parts };
    if (p) hold(chatId, p); // before any await, so a message arriving meanwhile sees this letter
    try {
      await deleteQuietly(chatId, letter.ackId);
      if (!p) {
        log("rejected_too_long", { parts: parts.length, chars: length });
        await bot.api.sendMessage(chatId, tooLong(length));
        return;
      }
      const preview = await bot.api.sendMessage(chatId, previewText(p), { ...html, reply_markup: previewButtons });
      if (pending.get(chatId) !== p) return void deleteQuietly(chatId, preview.message_id); // replaced meanwhile
      p.previewId = preview.message_id;
      log("preview", { parts: parts.length, chars: length, source: combineOrigins(parts.map((x) => x.origin)).source });
    } catch (err) {
      log("error", { where: "preview", error: describe(err) });
      if (p && pending.get(chatId) === p && !p.previewId) {
        takePending(chatId); // no preview means no Seal button: don't keep the letter
        await bot.api.sendMessage(chatId, "Something went wrong showing the preview. Please forward the letter again.").catch(() => {});
      }
    }
  }

  /** Opens the merge window for a letter and acknowledges it with a "That's everything" button. */
  async function collect(ctx: Context, chatId: number, letter: Letter, parts: Part[], ackText: string) {
    collecting.set(chatId, letter);
    for (const p of parts) windows.add(chatId, p);
    const ack = await ctx.reply(ackText, { reply_markup: flushButton });
    lastAck.set(chatId, ack.message_id);
    if (collecting.get(chatId) === letter) letter.ackId = ack.message_id;
    else await deleteQuietly(chatId, ack.message_id); // the window already closed
  }

  const pm = bot.chatType("private");

  pm.command("start", (ctx) => sealingClosed()
    ? ctx.reply(closedMessage())
    : ctx.reply(`${T.intro(cfg.unlockMs)}\n\n${T.consent(cfg.unlockMs)}`, { ...html, reply_markup: agreeButton }));

  pm.callbackQuery("consent", async (ctx) => {
    store.addConsent(ownerOf(ctx));
    log("consent");
    await ctx.answerCallbackQuery("Thank you").catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply(T.promptMessage(), html);
  });

  pm.command("help", (ctx) => ctx.reply(T.help(), html));
  pm.command("privacy", (ctx) => ctx.reply(T.privacy(cfg.unlockMs), html));

  pm.command("mine", async (ctx) => {
    const rows = store.listMine(ownerOf(ctx));
    if (!rows.length) return ctx.reply("You have no capsules yet. Forward your agent's letter to seal one.");
    const line = (c: Capsule) =>
      `• <b>${capsuleLabel(c)}</b>, sealed ${dateIST(Date.parse(c.sealed_at))}, opens ${dateTimeIST(Date.parse(c.unlock_at))}\n${link(c.id)}\n<code>/burn ${c.id}</code>`;
    for (let i = 0; i < rows.length; i += MINE_PAGE) {
      const page = rows.slice(i, i + MINE_PAGE).map(line).join("\n\n");
      await ctx.reply(i === 0 ? `Your capsules (keep these links private):\n\n${page}` : page, html);
    }
  });

  pm.command("burn", async (ctx) => {
    const id = ctx.match.trim().split("/").pop() ?? "";
    if (!id) return ctx.reply("Send /burn followed by the capsule id. /mine lists them.");
    if (!store.burn(id, ownerOf(ctx))) return ctx.reply("I can't find that capsule among yours. /mine lists them.");
    log("burned");
    await ctx.reply(`Deleted our copy. Your .age file still opens the letter after ${dateTimeIST(cfg.unlockMs)} at ${cfg.publicBaseUrl}/open.`, html);
  });

  pm.command("village", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T.help(), html);
    const dropped = await discardLetter(ctx.chat.id); // otherwise ODIN's verse would join that letter
    villageNext.add(ctx.chat.id);
    await ctx.reply(`${dropped ? "I discarded the letter in progress. " : ""}Forward ODIN's letter now. It will be sealed as ODIN's letter to the village.`);
  });

  pm.command("demo_seed", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T.help(), html);
    const ownerHash = ownerOf(ctx);
    const base = { kind: "demo" as const, ownerHash, agentHash: null, source: "unverified" as const };
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await sealCapsule(store, { ...base, text: DEMO_LETTER, round: cfg.round }));
    // One that opens in two minutes, to rehearse a capsule page opening itself.
    made.push(await sealCapsule(store, { ...base, text: DEMO_LETTER, round: roundIn(120) }));
    log("demo_seeded", { count: made.length });
    await ctx.reply(`Created ${made.length} demo capsules. They are labelled Demo and never counted as real. The last one opens in 2 minutes.\n\n${made.map((m) => link(m.id)).join("\n")}`, html);
  });

  pm.on("message", async (ctx) => {
    const msg = ctx.message;
    const chatId = ctx.chat.id;
    const text = msg.text ?? msg.caption ?? "";
    const forwarded = Boolean(msg.forward_origin);
    if (!forwarded && text.startsWith("/")) return ctx.reply(T.help(), html);
    if (sealingClosed()) return ctx.reply(closedMessage());
    if (!store.hasConsent(ownerOf(ctx))) {
      return ctx.reply(`Before I seal anything, please read this and tap I agree. Then forward the letter again.\n\n${T.consent(cfg.unlockMs)}`, { ...html, reply_markup: agreeButton });
    }
    const album = msg.media_group_id;
    if (!text.trim()) {
      if (!album) return ctx.reply(TEXT_ONLY);
      // An album arrives as one message per photo, and only one of them carries the caption.
      // Forwarded photos are deleted on Seal with the letter; the resident's own are left alone.
      const letter = collecting.get(chatId);
      if (letter) return void (forwarded && letter.extraIds.push(msg.message_id));
      const stray = strays.get(chatId);
      if (stray?.group === album) return void (forwarded && stray.ids.push(msg.message_id));
      const s: Stray = { group: album, ids: forwarded ? [msg.message_id] : [] };
      strays.set(chatId, s);
      const notice = await ctx.reply(TEXT_ONLY);
      if (strays.get(chatId) === s) s.noticeId = notice.message_id; // removed if the album's caption turns up
      else await deleteQuietly(chatId, notice.message_id);
      return;
    }

    const part: Part = {
      messageId: msg.message_id, text, origin: classifyOrigin(msg), forwarded, sentAt: msg.forward_origin?.date ?? msg.date,
    };
    const open = collecting.get(chatId);
    if (open) {
      // The same part forwarded twice counts once, and the copy is still deleted on Seal.
      if (windows.peek(chatId)?.some((x) => x.text.trim() === text.trim())) {
        return void (forwarded && open.extraIds.push(msg.message_id));
      }
      windows.add(chatId, part);
      // ODIN's forward can join a letter that a note typed after /village opened.
      if (forwarded && villageNext.delete(chatId)) open.kind = "village";
      return;
    }
    const secs = Math.round(windowMs / 1000);
    const earlier = pending.get(chatId);
    let replaced = false;
    if (earlier) {
      if (!forwarded) return ctx.reply("Tap Seal or Cancel on the preview above first.");
      if (sameReply(earlier.parts, part)) {
        // A late part of the same reply goes back into its letter, in order.
        takePending(chatId);
        await deleteQuietly(chatId, earlier.previewId);
        const copy = earlier.parts.some((x) => x.text.trim() === text.trim());
        log("collecting", { message_id: msg.message_id, kind: earlier.kind, reopened: true });
        return collect(ctx, chatId, { kind: earlier.kind, extraIds: copy ? [...earlier.extraIds, msg.message_id] : earlier.extraIds },
          copy ? earlier.parts : [...earlier.parts, part],
          `Added that to the letter. I'll wait ${secs} seconds in case there are more parts.`);
      }
      replaced = await discardLetter(chatId); // a different reply starts a new letter
    }
    if (overLimit(ctx)) return ctx.reply(limitMessage);

    // Photos of this album that arrived before its caption join the letter, and the notice goes.
    const stray = strays.get(chatId);
    strays.delete(chatId);
    const adopted = album && stray?.group === album ? stray : undefined;
    if (adopted) await deleteQuietly(chatId, adopted.noticeId);
    const kind: Kind = forwarded && villageNext.delete(chatId) ? "village" : "resident";
    log("collecting", { message_id: msg.message_id, kind });
    await collect(ctx, chatId, { kind, extraIds: adopted?.ids ?? [] }, [part],
      `${replaced ? "That starts a new letter, so I discarded the previous preview. " : "Got it. "}I'll wait ${secs} seconds in case the reply came in several parts. Forward any other parts now.`);
  });

  // Fixing a typo in a typed letter updates the letter and its preview.
  pm.on("edited_message", async (ctx) => {
    const msg = ctx.editedMessage;
    const chatId = ctx.chat.id;
    const text = msg.text ?? msg.caption ?? "";
    const p = pending.get(chatId);
    const part = [...(windows.peek(chatId) ?? []), ...(p?.parts ?? [])].find((x) => x.messageId === msg.message_id);
    if (!part || !text.trim()) return;
    part.text = text;
    log("part_edited", { message_id: msg.message_id });
    if (p?.previewId && p.parts.includes(part)) {
      await ctx.api.editMessageText(chatId, p.previewId, previewText(p), { ...html, reply_markup: previewButtons }).catch(() => {});
    }
  });

  pm.callbackQuery("flush", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.answerCallbackQuery().catch(() => {});
    const tappedId = ctx.callbackQuery.message?.message_id;
    const letter = collecting.get(chatId);
    if (letter && windows.isOpen(chatId)) {
      if (letter.ackId === undefined || letter.ackId === tappedId) return windows.close(chatId);
      return;
    }
    // Already handled here: a second tap, or the window closed itself a moment ago.
    if (pending.has(chatId) || lastAck.get(chatId) === tappedId) return;
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply("Nothing is waiting any more, probably because I restarted. Please forward the letter again.");
  });

  /** The chat's pending letter, but only if the tapped button belongs to its own preview. */
  function tapped(ctx: Context) {
    const p = pending.get(ctx.chat!.id);
    return p && p.previewId === ctx.callbackQuery?.message?.message_id ? p : undefined;
  }

  pm.callbackQuery("cancel", async (ctx) => {
    const p = tapped(ctx);
    if (p) takePending(ctx.chat.id);
    await ctx.answerCallbackQuery(p ? "Cancelled" : "This preview is no longer active").catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    if (!p) return;
    log("cancelled", { parts: p.parts.length });
    await ctx.reply("Cancelled. Nothing was stored. Forward a letter whenever you're ready.");
  });

  pm.callbackQuery("seal", async (ctx) => {
    const chatId = ctx.chat.id;
    const answer = (text?: string, show_alert = false) =>
      ctx.answerCallbackQuery(text ? { text, show_alert } : undefined).catch(() => {});
    const p = tapped(ctx);
    if (!p) {
      await answer("This preview is no longer active. Forward the letter again.", true);
      return ctx.deleteMessage().catch(() => {}); // an old preview still shows the start of a letter
    }
    if (sealingClosed()) {
      await discardLetter(chatId);
      await answer();
      return ctx.reply(closedMessage());
    }
    if (overLimit(ctx)) {
      await answer();
      return ctx.reply(limitMessage);
    }
    const text = mergeText(p.parts);
    if (text.length > MAX_CHARS) { // an edit can make it longer after the preview
      await answer();
      return ctx.reply(tooLong(text.length));
    }
    takePending(chatId);
    await answer("Sealing…");

    const origin = combineOrigins(p.parts.map((x) => x.origin));
    let capsule;
    try {
      capsule = await sealCapsule(store, {
        text,
        kind: p.kind,
        round: cfg.round,
        ownerHash: ownerOf(ctx),
        agentHash: origin.agentUsername ? saltedHash(cfg.hashSalt, "agent", origin.agentUsername) : null,
        source: origin.source,
      });
    } catch (err) {
      log("error", { where: "seal", error: describe(err) });
      hold(chatId, p); // keep the letter, so Seal can be tapped again
      return ctx.reply("Sorry, sealing failed and nothing was stored. Tap Seal to try again, or Cancel.");
    }
    const forwardedIds = p.parts.filter((x) => x.forwarded).map((x) => x.messageId);
    const typed = p.parts.length - forwardedIds.length;
    p.parts.length = 0; // the plaintext is gone from here on
    log("sealed", { kind: p.kind, parts: forwardedIds.length + typed, source: origin.source });

    // Only forwarded messages are deleted: what the resident typed here may be their only copy.
    const cleaned = await ctx.api.deleteMessages(chatId, [...forwardedIds, ...p.extraIds, p.previewId!]).then(
      () => true,
      (err) => {
        log("error", { where: "delete_messages", error: describe(err) });
        return false;
      },
    );
    const from = origin.source === "agent" ? "your agent's chat" : "the chat you forwarded it from";
    const cleanup = !cleaned
      ? "I couldn't delete the messages from this chat, so you may want to delete them yourself."
      : typed === 0
        ? `I deleted the forwarded messages and the preview from this chat. The original still exists in ${from}.`
        : `I deleted ${forwardedIds.length ? "the forwarded messages and " : ""}the preview from this chat. What you typed is still here, so delete it if you like.`;
    const url = link(capsule.id);
    try {
      await ctx.reply([
        `<b>Sealed</b> ✉️ ${p.kind === "village" ? "ODIN's letter to the village is" : "Your letter is"} locked until ${dateTimeIST(cfg.unlockMs)} (drand round #${capsule.round}).`,
        cleanup,
        "",
        "Your capsule link. Keep it private: after the unlock date, anyone holding it can open the letter.",
        url,
      ].join("\n"), html);
      await ctx.replyWithDocument(new InputFile(Buffer.from(capsule.ciphertext, "utf8"), `dear-me-${capsule.id}.age`), {
        caption: `The capsule file. It opens after the unlock date at ${cfg.publicBaseUrl}/open, or with drand's tle tool, even if our server is gone.`,
      });
      await ctx.replyWithDocument(new InputFile(Buffer.from(calendarFile({ url, startMs: cfg.unlockMs }), "utf8"), "dear-me-opens.ics"), {
        caption: `A calendar reminder for ${dateTimeIST(cfg.unlockMs)}.`,
      });
    } catch (err) {
      log("error", { where: "send_capsule", error: describe(err) });
      await ctx.reply("Your letter is sealed, but sending its link and files failed. Send /mine to get the link.").catch(() => {});
    }
  });

  // No group chats.
  bot.on("my_chat_member", async (ctx) => {
    if (ctx.chat.type !== "private") await ctx.leaveChat().catch(() => {});
  });

  bot.catch((err) => log("error", { update_id: err.ctx.update.update_id, error: describe(err.error) }));

  return bot;
}

/** Error text for logs: Telegram's method and code, or our own error message. Never update contents. */
function describe(err: unknown): string {
  if (err instanceof GrammyError) return `${err.method}: ${err.error_code} ${err.description}`;
  return err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
}

export const BOT_COMMANDS = [
  { command: "start", description: "Start and agree to the privacy terms" },
  { command: "mine", description: "Your capsules and their links" },
  { command: "burn", description: "Delete our copy of a capsule" },
  { command: "privacy", description: "What is stored and what is not" },
  { command: "help", description: "How it works" },
];
