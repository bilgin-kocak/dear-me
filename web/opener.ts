// Opening a capsule in the browser: the "too early" attempt, waiting for the
// round, and the capsule view shared by /c/:id and /open.
import { CHAIN, RELAYS, beaconUrl, isTooEarly, open, quicknet, timeOfRound } from "../src/lock.ts";
import { $, countdown, download, fmtIST, reducedMotion, revealInView, showErrors, sleep, typewriter } from "./ui.ts";

/** AbortSignal.timeout() arrived in Safari 16; iOS 15 phones need the fallback. */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
const get = (url: string) => fetch(url, { cache: "no-store", signal: timeoutSignal(5000) });

export async function latestRound(): Promise<number | undefined> {
  try {
    return (await (await get(`${RELAYS[0]}/${CHAIN.hash}/public/latest`)).json()).round;
  } catch {
    return undefined;
  }
}

/**
 * The real attempt: tlock-js refuses, and drand itself has no key for the round yet.
 * Resolves with the letter if the round has already been published.
 */
export async function tryOpenNow(armored: string, round: number): Promise<{ text: string } | { errors: string[] }> {
  try {
    return { text: await open(armored) };
  } catch (err) {
    const errors = [`tlock-js: ${(err as Error).message}`];
    // drand answers 425 Too Early for rounds well ahead. For the next round or two it
    // holds the request or answers 500 instead, which would only confuse the audience.
    if (isTooEarly(err) && timeOfRound(round) - Date.now() > 6000) {
      try {
        const [res, latest] = await Promise.all([get(beaconUrl(round)), latestRound()]);
        if (res.status === 425) errors.push(`drand: GET /public/${round} → 425 Too Early${latest ? `. Latest published round: #${latest}` : ""}`);
      } catch {
        // Offline: the tlock error says enough.
      }
    }
    return { errors };
  }
}

/** Retrying helps while the key isn't out yet or a relay hiccups. A damaged capsule fails for good. */
const transient = (err: unknown) => isTooEarly(err) || /fetch|network|Error response/i.test(String((err as Error)?.message));

/**
 * Waits for the round's time, then polls drand every second and opens the capsule as
 * soon as the beacon exists. Throws if the capsule itself cannot be opened.
 */
export async function openWhenDue(
  armored: string,
  round: number,
  onWaiting?: (attempt: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  await sleep(timeOfRound(round) - Date.now());
  let relay = 0;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error("stopped");
    let published = false;
    try {
      const res = await get(beaconUrl(round, RELAYS[relay]));
      published = res.ok;
      if (res.status >= 500) relay = (relay + 1) % RELAYS.length;
    } catch {
      relay = (relay + 1) % RELAYS.length; // this relay is unreachable or slow: try the next one
    }
    if (published) {
      try {
        return await open(armored, quicknet(RELAYS[relay]));
      } catch (err) {
        if (!transient(err)) throw err;
      }
    }
    onWaiting?.(attempt);
    await sleep(1000);
  }
}

const CAPSULE_VIEW = `
  <div class="env big" data-env><span class="seal"></span></div>
  <h1 class="title" data-title></h1>
  <p class="muted" data-label></p>
  <p class="opens">Opens <strong data-opens></strong></p>
  <div data-countdown></div>
  <p class="muted small" data-note>Locked to drand quicknet round <strong data-round></strong>. Its key does not exist until the League of Entropy publishes that round.</p>
  <div class="actions">
    <button data-try>Try to open now</button>
    <button class="ghost" data-download>Download .age file</button>
  </div>
  <div class="errors" data-errors hidden></div>
  <p class="status" data-status hidden></p>
  <article class="letter" data-letter hidden></article>
  <p class="proof" data-proof hidden></p>`;

/**
 * Shared by /c/:id and /open: date, countdown, the "too early" attempt, and the
 * reveal when due. Returns a function that stops the countdown and the polling.
 */
export function showCapsule(root: HTMLElement, c: { armored: string; round: number; title: string; label: string; fileName: string }) {
  root.innerHTML = CAPSULE_VIEW;
  const abort = new AbortController();
  const live = () => !abort.signal.aborted;
  // Look the elements up once: work left over from a disposed view then only touches its own detached nodes.
  const el: Record<string, HTMLElement> = {};
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    for (const name of node.getAttributeNames()) if (name.startsWith("data-")) el[name.slice(5)] = node;
  }
  const due = timeOfRound(c.round);
  el.title.textContent = c.title;
  el.label.textContent = c.label;
  el.opens.textContent = fmtIST(due);
  el.round.textContent = `#${c.round}`;
  el.download.onclick = () => download(c.fileName, c.armored);

  let revealed = false;
  async function reveal(text: string) {
    if (revealed || !live()) return;
    revealed = true;
    stop();
    for (const name of ["errors", "status", "try", "countdown"]) el[name].hidden = true;
    el.note.textContent = `The League of Entropy published the key for drand round #${c.round} on ${fmtIST(due)}.`;
    el.env.classList.add("opened");
    await sleep(reducedMotion() ? 0 : 900);
    // Reserve the letter's full height and scroll to it: on a phone it opens below the fold.
    // Nothing paints before typewriter() clears the text again.
    el.letter.hidden = false;
    el.letter.textContent = text;
    el.letter.style.minHeight = `${el.letter.offsetHeight}px`;
    revealInView(el.letter);
    await typewriter(el.letter, text);
    el.proof.innerHTML = `Opened by drand round <a target="_blank" rel="noreferrer"></a>`;
    const a = $<HTMLAnchorElement>("a", el.proof);
    a.href = beaconUrl(c.round);
    a.textContent = `#${c.round}`;
    el.proof.hidden = false;
  }

  el.try.onclick = async () => {
    const btn = el.try as HTMLButtonElement;
    btn.disabled = true;
    const result = await tryOpenNow(c.armored, c.round);
    btn.disabled = false;
    if (!live() || revealed) return; // the letter opened, or another capsule replaced this view, meanwhile
    if ("text" in result) return reveal(result.text);
    showErrors(el.errors, result.errors);
  };

  const stop = countdown(el.countdown, due, async () => {
    if (!live()) return;
    el.status.textContent = `Round #${c.round} is due. Fetching its key from drand…`;
    el.status.hidden = false;
    try {
      const text = await openWhenDue(c.armored, c.round, (n) => {
        if (live()) el.status.textContent = `Waiting for drand to publish round #${c.round}… (${n})`;
      }, abort.signal);
      await reveal(text);
    } catch (err) {
      if (!live() || revealed) return;
      el.status.hidden = true;
      showErrors(el.errors, [`This capsule can't be opened: ${(err as Error).message}`]);
    }
  });
  return () => {
    stop();
    abort.abort();
  };
}
