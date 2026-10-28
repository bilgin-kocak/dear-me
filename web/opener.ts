// Opening a capsule in the browser: the "too early" attempt, waiting for the
// round, and the capsule view shared by /c/:id and /open.
import { CHAIN, RELAYS, beaconUrl, open, quicknet, timeOfRound } from "../src/lock.ts";
import { $, countdown, download, fmtIST, reducedMotion, sleep, typewriter } from "./ui.ts";

export async function latestRound(): Promise<number | undefined> {
  try {
    const res = await fetch(`${RELAYS[0]}/${CHAIN.hash}/public/latest`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    return (await res.json()).round;
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
    try {
      const [res, latest] = await Promise.all([
        fetch(beaconUrl(round), { cache: "no-store", signal: AbortSignal.timeout(5000) }),
        latestRound(),
      ]);
      const status = res.status === 425 ? "425 Too Early" : `${res.status}`;
      errors.push(`drand: GET /public/${round} → ${status}${latest ? `. Latest published round: #${latest}` : ""}`);
    } catch {
      // Offline: the tlock error says enough.
    }
    return { errors };
  }
}

/** Waits for the round's time, then polls drand every second and opens as soon as the beacon exists. */
export async function openWhenDue(
  armored: string,
  round: number,
  onWaiting?: (attempt: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  await sleep(timeOfRound(round) - Date.now());
  let relay = 0;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(beaconUrl(round, RELAYS[relay]), { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (res.ok) return await open(armored, quicknet(RELAYS[relay]));
      if (res.status >= 500) relay = (relay + 1) % RELAYS.length;
    } catch {
      relay = (relay + 1) % RELAYS.length; // this relay is unreachable or slow: try the next one
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
  <p class="muted small">Locked to drand quicknet round <strong data-round></strong>. Its key does not exist until the League of Entropy publishes that round.</p>
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
  const el = (name: string) => $(`[data-${name}]`, root);
  const due = timeOfRound(c.round);
  el("title").textContent = c.title;
  el("label").textContent = c.label;
  el("opens").textContent = fmtIST(due);
  el("round").textContent = `#${c.round}`;
  el("download").onclick = () => download(c.fileName, c.armored);

  let revealed = false;
  async function reveal(text: string) {
    if (revealed) return;
    revealed = true;
    stop();
    el("errors").hidden = true;
    el("status").hidden = true;
    el("try").hidden = true;
    el("env").classList.add("opened");
    await sleep(reducedMotion() ? 0 : 900);
    const letter = el("letter");
    letter.hidden = false;
    await typewriter(letter, text);
    const proof = el("proof");
    proof.innerHTML = `Opened by drand round <a target="_blank" rel="noreferrer"></a>`;
    const a = $("a", proof) as HTMLAnchorElement;
    a.href = beaconUrl(c.round);
    a.textContent = `#${c.round}`;
    proof.hidden = false;
  }

  el("try").onclick = async () => {
    const btn = el("try") as HTMLButtonElement;
    btn.disabled = true;
    const result = await tryOpenNow(c.armored, c.round);
    btn.disabled = false;
    if ("text" in result) return reveal(result.text);
    const box = el("errors");
    box.replaceChildren(...result.errors.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
    box.hidden = false;
    box.classList.remove("shake");
    void box.offsetWidth;
    box.classList.add("shake");
  };

  const stop = countdown(el("countdown"), due, async () => {
    const status = el("status");
    status.textContent = `Round #${c.round} is due. Fetching its key from drand…`;
    status.hidden = false;
    reveal(await openWhenDue(c.armored, c.round, (n) => {
      status.textContent = `Waiting for drand to publish round #${c.round}… (${n})`;
    }, abort.signal));
  });
  return () => {
    stop();
    abort.abort();
  };
}
