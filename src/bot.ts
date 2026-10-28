import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { dateIST, dateTimeIST, type Config } from "./config.ts";
import type { Capsule, Kind, Store } from "./db.ts";
import { saltedHash } from "./hash.ts";
import { calendarFile } from "./ics.ts";
import { roundIn } from "./lock.ts";
import type { Log } from "./log.ts";
import { createMergeWindow, MERGE_WINDOW_MS, mergeText } from "./merge.ts";
import { classifyOrigin, combineOrigins, SOURCE_LABEL, type Origin } from "./origin.ts";
import { sealCapsule } from "./seal.ts";
import * as T from "./texts.ts";

export const MAX_CHARS = 4000;
export const MAX_PER_DAY = 3;
const PREVIEW_CHARS = 80;
const PREVIEW_TTL_MS = 30 * 60_000; // an unanswered preview is forgotten after 30 minutes

type Part = { messageId: number; text: string; origin: Origin };
type Pending = { parts: Part[]; kind: Kind; previewId: number; expiry: ReturnType<typeof setTimeout> };

const KIND_LABEL: Record<Kind, string> = {
  resident: "Letter from your agent",
  village: "ODIN's letter to the village",
  demo: "Demo",
};

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

  // Plaintext lives only in these two in-memory structures, and only until Seal, Cancel or expiry.
  const windows = createMergeWindow<Part>(opts.mergeWindowMs ?? MERGE_WINDOW_MS, (chatId, parts) => showPreview(chatId, parts));
  const pending = new Map<number, Pending>();
  const collecting = new Map<number, { kind: Kind; ackId?: number }>();
  const villageNext = new Set<number>(); // admin chats whose next letter is ODIN's

  const ownerOf = (ctx: Context) => saltedHash(cfg.hashSalt, "owner", ctx.from!.id);
  const isAdmin = (ctx: Context) => cfg.adminIds.has(ctx.from?.id ?? Number.NaN);
  const link = (id: string) => `${cfg.publicBaseUrl}/c/${id}`;
  const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
  const agreeButton = new InlineKeyboard().text("I agree", "consent");
  const overLimit = (ownerHash: string) =>
    store.sealedSince(ownerHash, new Date(Date.now() - 86_400_000).toISOString()) >= MAX_PER_DAY;
  const limitMessage = `You've sealed ${MAX_PER_DAY} letters in the last 24 hours, which is the limit. Try again tomorrow.`;

  function takePending(chatId: number) {
    const p = pending.get(chatId);
    if (p) clearTimeout(p.expiry);
    pending.delete(chatId);
    return p;
  }

  async function showPreview(chatId: number, parts: Part[]) {
    try {
      const { kind = "resident", ackId } = collecting.get(chatId) ?? {};
      collecting.delete(chatId);
      if (ackId) await bot.api.deleteMessage(chatId, ackId).catch(() => {});

      const text = mergeText(parts);
      if (text.length > MAX_CHARS) {
        log("rejected_too_long", { parts: parts.length, chars: text.length });
        await bot.api.sendMessage(chatId, `That letter is ${text.length.toLocaleString("en")} characters. The limit is ${MAX_CHARS.toLocaleString("en")}, so ask your agent for a shorter one (the prompt asks for under 300 words) and forward it again.`);
        return;
      }
      const origin = combineOrigins(parts.map((p) => p.origin));
      const head = Array.from(text).slice(0, PREVIEW_CHARS).join("");
      const preview = await bot.api.sendMessage(chatId, [
        `<b>${kind === "village" ? KIND_LABEL.village : "Preview"}</b>`,
        `<i>${T.esc(head)}${head.length < text.length ? "…" : ""}</i>`,
        "",
        `${text.length.toLocaleString("en")} characters · ${parts.length} ${parts.length === 1 ? "part" : "parts"} · ${SOURCE_LABEL[origin.source]}`,
      ].join("\n"), {
        ...html,
        reply_markup: new InlineKeyboard().text(`Seal until ${dateIST(cfg.unlockMs)}`, "seal").text("Cancel", "cancel"),
      });
      const expiry = setTimeout(() => {
        if (!takePending(chatId)) return;
        log("preview_expired", { parts: parts.length });
        bot.api.deleteMessage(chatId, preview.message_id).catch(() => {});
      }, PREVIEW_TTL_MS);
      pending.set(chatId, { parts, kind, previewId: preview.message_id, expiry });
      log("preview", { parts: parts.length, chars: text.length, source: origin.source });
    } catch (err) {
      log("error", { where: "preview", error: describe(err) });
    }
  }

  const pm = bot.chatType("private");

  pm.command("start", (ctx) =>
    ctx.reply(`${T.intro(cfg.unlockMs)}\n\n${T.consent(cfg.unlockMs)}`, { ...html, reply_markup: agreeButton }));

  pm.callbackQuery("consent", async (ctx) => {
    store.addConsent(ownerOf(ctx));
    log("consent");
    await ctx.answerCallbackQuery("Thank you");
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply(T.promptMessage(), html);
  });

  pm.command("help", (ctx) => ctx.reply(T.help(), html));
  pm.command("privacy", (ctx) => ctx.reply(T.privacy(cfg.unlockMs), html));

  pm.command("mine", async (ctx) => {
    const rows = store.listMine(ownerOf(ctx));
    if (!rows.length) return ctx.reply("You have no capsules yet. Forward your agent's letter to seal one.");
    const line = (c: Capsule) =>
      `• <b>${KIND_LABEL[c.kind]}</b>, sealed ${dateIST(Date.parse(c.sealed_at))}, opens ${dateTimeIST(Date.parse(c.unlock_at))}\n${link(c.id)}\n<code>/burn ${c.id}</code>`;
    await ctx.reply(`Your capsules (keep these links private):\n\n${rows.map(line).join("\n\n")}`, html);
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
    villageNext.add(ctx.chat.id);
    await ctx.reply("Forward ODIN's letter now. It will be sealed as ODIN's letter to the village.");
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
    const text = msg.text ?? msg.caption ?? "";
    if (!msg.forward_origin && text.startsWith("/")) return ctx.reply(T.help(), html);
    if (!store.hasConsent(ownerOf(ctx))) {
      return ctx.reply(`Before I seal anything, please read this and tap I agree. Then forward the letter again.\n\n${T.consent(cfg.unlockMs)}`, { ...html, reply_markup: agreeButton });
    }
    if (!text.trim()) return ctx.reply("I can only seal text. Forward your agent's text reply.");

    const chatId = ctx.chat.id;
    const part: Part = { messageId: msg.message_id, text, origin: classifyOrigin(msg) };
    if (collecting.has(chatId)) {
      windows.add(chatId, part);
      return;
    }
    // A part that arrives after the preview reopens the letter instead of starting a new one.
    const earlier = takePending(chatId);
    if (earlier) await ctx.api.deleteMessage(chatId, earlier.previewId).catch(() => {});
    const kind: Kind = earlier?.kind ?? (villageNext.delete(chatId) ? "village" : "resident");
    if (overLimit(ownerOf(ctx))) return ctx.reply(limitMessage);

    const info: { kind: Kind; ackId?: number } = { kind };
    collecting.set(chatId, info);
    for (const p of [...(earlier?.parts ?? []), part]) windows.add(chatId, p);
    log("collecting", { message_id: msg.message_id, kind });
    const ack = await ctx.reply(
      `Got it. I'll wait ${Math.round((opts.mergeWindowMs ?? MERGE_WINDOW_MS) / 1000)} seconds in case the reply came in several parts. Forward any other parts now.`,
      { reply_markup: new InlineKeyboard().text("That's everything", "flush") },
    );
    info.ackId = ack.message_id;
  });

  pm.callbackQuery("flush", async (ctx) => {
    await ctx.answerCallbackQuery();
    await windows.close(ctx.chat.id);
  });

  pm.callbackQuery("cancel", async (ctx) => {
    const p = takePending(ctx.chat.id);
    await ctx.answerCallbackQuery(p ? "Cancelled" : "Nothing to cancel");
    await ctx.deleteMessage().catch(() => {});
    if (p) {
      log("cancelled", { parts: p.parts.length });
      await ctx.reply("Cancelled. Nothing was stored. Forward a letter whenever you're ready.");
    }
  });

  pm.callbackQuery("seal", async (ctx) => {
    const chatId = ctx.chat.id;
    const p = takePending(chatId);
    if (!p) return ctx.answerCallbackQuery({ text: "This preview expired. Forward the letter again.", show_alert: true });
    const ownerHash = ownerOf(ctx);
    if (overLimit(ownerHash)) {
      await ctx.answerCallbackQuery();
      return ctx.reply(limitMessage);
    }
    await ctx.answerCallbackQuery("Sealing…");

    const origin = combineOrigins(p.parts.map((x) => x.origin));
    const partIds = p.parts.map((x) => x.messageId);
    let capsule;
    try {
      capsule = await sealCapsule(store, {
        text: mergeText(p.parts),
        kind: p.kind,
        round: cfg.round,
        ownerHash,
        agentHash: origin.agentUsername ? saltedHash(cfg.hashSalt, "agent", origin.agentUsername) : null,
        source: origin.source,
      });
    } finally {
      p.parts.length = 0; // the plaintext is gone from here on, sealed or not
    }
    log("sealed", { kind: p.kind, parts: partIds.length, source: origin.source });

    await ctx.api.deleteMessages(chatId, [...partIds, p.previewId]).catch((err) =>
      log("error", { where: "delete_messages", error: describe(err) }));
    const url = link(capsule.id);
    await ctx.reply([
      `<b>Sealed</b> ✉️ ${p.kind === "village" ? "ODIN's letter to the village is" : "Your letter is"} locked until ${dateTimeIST(cfg.unlockMs)} (drand round #${capsule.round}).`,
      "I deleted the forwarded messages and the preview from this chat. The original still exists in your agent's chat.",
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
