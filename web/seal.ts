// /seal: seals the letter in a seal link on this device. Only the locked capsule leaves it.
import { calendarFile } from "../src/ics.ts";
import { seal } from "../src/lock.ts";
import { readSealLink } from "../src/sealink.ts";
import { $, copyText, download, fmtIST, revealInView, showErrors, sleep } from "./ui.ts";

type Config = { unlockAt: string; round: number; maxChars: number };
type Sealed = { id: string; url: string };

const VIEWS = ["loading", "problem", "ready", "done"] as const;
const show = (view: (typeof VIEWS)[number]) => VIEWS.forEach((v) => ($(`#${v}`).hidden = v !== view));
const setDates = (ms: number) => document.querySelectorAll(".date").forEach((el) => (el.textContent = fmtIST(ms)));

const REFUSED: Record<number, string> = {
  400: "Our server didn't accept this capsule.",
  410: "Sealing has closed: the unlock date has passed.",
  413: "Our server didn't accept this capsule: it is too large.",
  429: "Many letters were sealed from this network in the last hour, so our server is pausing. Try again in a little while.",
};

function problem(title: string, text: string, retry = false) {
  $("#problemTitle").textContent = title;
  $("#problemText").textContent = text;
  $("#howto").hidden = retry;
  $("#retry").hidden = !retry;
  $("#retry").onclick = () => location.reload();
  show("problem");
}

async function loadConfig(): Promise<Config | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {
      // offline or redeploying: try again
    }
    await sleep(1500);
  }
  return null;
}

// This browser remembers the letters it sealed, so tapping the same link again shows the
// capsule instead of sealing a second copy. It keeps a hash of the letter, never the letter.
async function memoryKey(letter: string) {
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(letter)));
    return `dear-me:sealed:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null; // no Web Crypto outside HTTPS: then it doesn't remember
  }
}
function recall(key: string | null): Sealed | null {
  try {
    return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
  } catch {
    return null;
  }
}
/** False only when our server says the capsule is gone: its owner deleted our copy, so it can be sealed again. */
async function stillThere(id: string) {
  const res = await fetch(`/api/c/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => undefined);
  return !(res && (res.status === 404 || res.status === 410));
}
function remember(key: string | null, sealed: Sealed) {
  try {
    if (key) localStorage.setItem(key, JSON.stringify(sealed));
  } catch {
    // private mode or storage blocked: nothing to remember with
  }
}

function ready(letter: string, cfg: Config, unlockMs: number, key: string | null) {
  const words = letter.split(/\s+/).length;
  $("#about").textContent = `${words.toLocaleString("en")} ${words === 1 ? "word" : "words"}, to be locked with drand timelock encryption.`;
  const sealBtn = $<HTMLButtonElement>("#seal");
  const readBtn = $<HTMLButtonElement>("#read");
  $("#env").classList.add("opened");
  show("ready");

  readBtn.onclick = () => {
    const el = $("#letter");
    el.textContent = letter; // a letter is never HTML
    el.hidden = false;
    readBtn.hidden = true;
    sealBtn.textContent = "Seal it";
    revealInView(el);
  };

  let armored: string | undefined;
  sealBtn.onclick = async () => {
    sealBtn.disabled = readBtn.disabled = true;
    $("#errors").hidden = $("#keep").hidden = true;
    const label = sealBtn.textContent;
    sealBtn.textContent = "Sealing…";
    let reason: string;
    try {
      armored ??= await seal(letter, cfg.round); // no network: the chain info is pinned in code
      const res = await fetch("/api/capsules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ciphertext: armored }),
      });
      if (res.status === 201) {
        const { id, url }: Sealed = await res.json();
        remember(key, { id, url });
        return done({ id, url }, unlockMs, armored);
      }
      reason = REFUSED[res.status] ?? `Our server answered ${res.status}. Try again in a moment.`;
    } catch {
      reason = armored ? "Our server isn't answering. Try again in a moment." : "This browser couldn't seal the letter.";
    }
    sealBtn.disabled = readBtn.disabled = false;
    sealBtn.textContent = armored ? "Try again" : label;
    showErrors($("#errors"), [reason]);
    if (armored) {
      const capsule = armored;
      $("#keep").hidden = false;
      $("#keepAge").onclick = () => download("dear-me-letter.age", capsule);
    }
  };
}

function done(sealed: Sealed, unlockMs: number, armored?: string, again = false) {
  history.replaceState(null, "", location.pathname); // the letter leaves the address bar
  $("#env").classList.remove("opened");
  $("#doneTitle").textContent = again ? "You already sealed this letter" : "Sealed";
  const link = $<HTMLAnchorElement>("#capsuleLink");
  link.href = sealed.url;
  link.textContent = sealed.url.replace(/^https?:\/\//, "");
  const copy = $<HTMLButtonElement>("#copy");
  copy.onclick = async () => {
    copy.textContent = (await copyText(sealed.url)) ? "Copied" : "Select and copy it";
    setTimeout(() => (copy.textContent = "Copy link"), 2000);
  };
  $("#ics").onclick = () => download("dear-me-reminder.ics", calendarFile({ url: sealed.url, startMs: unlockMs }), "text/calendar");
  // A capsule sealed in an earlier visit downloads from its own page.
  $("#age").hidden = !armored;
  if (armored) $("#age").onclick = () => download(`dear-me-${sealed.id}.age`, armored);
  show("done");
}

async function start(letter: string) {
  const cfg = await loadConfig();
  if (!cfg) return problem("Our server isn't answering", "Your letter is still safe in the link. Try again in a minute.", true);
  const unlockMs = Date.parse(cfg.unlockAt);
  setDates(unlockMs);
  const key = await memoryKey(letter);
  const before = recall(key);
  if (before && (await stillThere(before.id))) return done(before, unlockMs, undefined, true);
  if (Date.now() >= unlockMs) {
    return problem("Sealing has closed", `Letters opened on ${fmtIST(unlockMs)}. A letter sealed now would open at once.`);
  }
  if (letter.length > cfg.maxChars) {
    return problem("This letter is too long", `It has ${letter.length.toLocaleString("en")} characters, and a letter can have up to ${cfg.maxChars.toLocaleString("en")}. Ask your agent for a shorter one, as a new seal link.`);
  }
  ready(letter, cfg, unlockMs, key);
}

// Tapping another seal link while this page is open only changes the part after "#".
addEventListener("hashchange", () => location.reload());

const fragment = location.hash.slice(1);
// Seal links are zlib-compressed: Safari before 16.4 can't unpack them.
const oldBrowser = typeof DecompressionStream !== "function";
const letter = fragment && !oldBrowser ? await readSealLink(fragment) : null;
if (oldBrowser) {
  problem("This browser is too old for seal links", "Open the link in an up-to-date browser, like Safari 16.4 or later, or Chrome.");
} else if (!fragment) {
  problem("No letter in this link", "This page seals a letter from a seal link, which your agent makes. The letter travels after the # in the link, and this link has nothing there.");
} else if (!letter) {
  problem("This link is damaged", "Part of the letter got lost or changed on the way, so it can't be read. Ask your agent to send the link again, exactly as its code printed it.");
} else {
  await start(letter);
}
