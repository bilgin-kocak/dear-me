// Everything the bot says. HTML parse mode.
import { dateTimeIST } from "./config.ts";
import { sealLinkPrompt } from "./prompt.ts";
import { SEAL_PATH } from "./sealink.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const intro = (unlockMs: number) => [
  "<b>Dear Me, From Your Agent</b> ✉️",
  "Ask your Agent Village agent to write you a letter to open in a year.",
  `It replies with a link, and one tap locks the letter with drand timelock encryption until ${dateTimeIST(unlockMs)}.`,
  "The key does not exist yet: the League of Entropy publishes it at that exact second.",
].join("\n");

export const consent = (unlockMs: number) => [
  `• Your agent's letter is locked until ${dateTimeIST(unlockMs)}. Nobody can open it before then: not you, not us.`,
  "• After that date, anyone holding your capsule file or link can open it. Keep them private.",
  "• The public wall only shows that a letter exists. Never its text, never your name.",
  "• You can delete our copy at any time with /burn.",
].join("\n");

export const promptMessage = (origin: string) =>
  `<pre>${esc(sealLinkPrompt(origin))}</pre>\n\nSend this to your Agent Village agent in your private chat. It replies with a link: tap it to seal the letter on your phone. If your agent can't make the link and writes the letter instead, forward the reply here.`;

/** What a seal link sent here gets: it is meant to be tapped, not forwarded. */
export const sealLinkHint = () =>
  `That's a seal link. Tap it to seal the letter on your phone: the letter never needs to pass through me. (Links look like …${SEAL_PATH}#…)`;

export const privacy = (unlockMs: number) => [
  "<b>Privacy</b>",
  consent(unlockMs),
  "",
  "• I hold your letter in memory only until you tap Seal. It is never written to our database, files or logs. Only the time-locked ciphertext is stored.",
  "• A letter sealed from your agent's seal link is sealed on your own device: our server only ever receives the ciphertext. Delete our copy of such a capsule from its page.",
  "• After sealing I delete the forwarded messages and the preview from this chat. The original is still in your agent's chat. Anything you typed yourself stays here for you to delete.",
  "• I store a salted hash of your Telegram id (for consent, /mine and limits) and, for agent-written letters, a salted hash of the agent's bot username (only to count unique agents).",
  "• I never connect to, change or read your Agent Village agent. Letters are written by residents' own agents and forwarded by the residents.",
].join("\n");

export const help = () => [
  "<b>How it works</b>",
  "1. /start and tap I agree.",
  "2. Send the prompt to your Agent Village agent.",
  "3. Tap the link it replies with: the letter is sealed on your phone.",
  "4. No link? Forward its reply here instead (several parts are fine, I wait 90 seconds), check the preview and tap Seal.",
  "",
  "/mine: your capsules and links",
  "/burn &lt;id&gt;: delete our copy (your .age file still works)",
  "/privacy: what is stored and what is not",
].join("\n");
