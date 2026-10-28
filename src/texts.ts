// Everything the bot says. HTML parse mode.
import { dateTimeIST } from "./config.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const intro = (unlockMs: number) => [
  "<b>Dear Me, From Your Agent</b> ✉️",
  "Ask your Agent Village agent to write you a letter to open in a year.",
  `Forward its reply here and I lock it with drand timelock encryption until ${dateTimeIST(unlockMs)}.`,
  "The key does not exist yet: the League of Entropy publishes it at that exact second.",
].join("\n");

export const consent = (unlockMs: number) => [
  `• Your agent's letter is locked until ${dateTimeIST(unlockMs)}. Nobody can open it before then: not you, not us.`,
  "• After that date, anyone holding your capsule file or link can open it. Keep them private.",
  "• The public wall only shows that a letter exists. Never its text, never your name.",
  "• You can delete our copy at any time with /burn.",
].join("\n");

// Section 6, exactly as written.
export const LETTER_PROMPT = `This is a one-off writing task. Please don't save anything from it to memory and don't record any intentions.

Write me a private letter that I will open on 31 October 2027, one year after Edge City India ends. Write it as yourself, my agent, using only what you actually know about me from our conversations and my profile. If you are guessing, say so.

Please include:
1. What I came to Edge City India for, in my own words if I told you.
2. What I said I would do next, as concretely as you can.
3. One moment or conversation from these weeks worth remembering.
4. One thing you may have gotten wrong about me.
5. Three questions for me to answer in October 2027.

Use first names only for other people, and no contact details. Plain text, no headings or markdown, under 300 words. Start with "Dear" and my name, and sign with your own name.`;

export const promptMessage = () =>
  `<pre>${esc(LETTER_PROMPT)}</pre>\n\nSend this to your Agent Village agent in your private chat. When it replies, forward the reply here.`;

export const privacy = (unlockMs: number) => [
  "<b>Privacy</b>",
  consent(unlockMs),
  "",
  "• I hold your letter in memory only until you tap Seal. It is never written to our database, files or logs. Only the time-locked ciphertext is stored.",
  "• After sealing I delete the forwarded messages and the preview from this chat. The original is still in your agent's chat. Anything you typed yourself stays here for you to delete.",
  "• I store a salted hash of your Telegram id (for consent, /mine and limits) and, for agent-written letters, a salted hash of the agent's bot username (only to count unique agents).",
  "• I never connect to, change or read your Agent Village agent. Letters are written by residents' own agents and forwarded by the residents.",
].join("\n");

export const help = () => [
  "<b>How it works</b>",
  "1. /start and tap I agree.",
  "2. Send the prompt to your Agent Village agent.",
  "3. Forward its reply here (several parts are fine, I wait 90 seconds).",
  "4. Check the preview and tap Seal.",
  "",
  "/mine: your capsules and links",
  "/burn &lt;id&gt;: delete our copy (your .age file still works)",
  "/privacy: what is stored and what is not",
].join("\n");
