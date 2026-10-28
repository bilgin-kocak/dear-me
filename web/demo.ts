// Stage mode: seal in the browser, fail to open early, open the moment drand publishes the round.
import { beaconUrl, roundIn, seal, timeOfRound } from "../src/lock.ts";
import { openWhenDue, tryOpenNow } from "./opener.ts";
import { $, bringIntoView, fmtTime, showErrors, sleep, typewriter } from "./ui.ts";

type Run = { armored: string; round: number; opened: boolean; abort: AbortController };
let current: Run | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;

const show = (id: "compose" | "sealed" | "opened") =>
  (["compose", "sealed", "opened"] as const).forEach((s) => ($(`#${s}`).hidden = s !== id));

async function start(seconds: number) {
  const text = $<HTMLTextAreaElement>("#text").value.trim();
  if (!text) return;
  const buttons = [$<HTMLButtonElement>("#seal60"), $<HTMLButtonElement>("#seal30")];
  buttons.forEach((b) => (b.disabled = true));
  const round = roundIn(seconds); // roundAt(Date.now() + seconds * 1000)
  const due = timeOfRound(round);
  const armored = await seal(text, round);
  buttons.forEach((b) => (b.disabled = false));
  const run: Run = (current = { armored, round, opened: false, abort: new AbortController() });

  $("#cipher").textContent = `${armored}\n${armored}\n`; // twice, for a seamless scroll
  $("#roundInfo").textContent = `Locked to drand round #${round}. Its key will be published at ${fmtTime(due, true)}.`;
  $("#errors").hidden = true;
  $("#status").hidden = true;
  $("#env").classList.remove("opened");
  show("sealed");

  const count = $("#count");
  clearInterval(ticker);
  ticker = setInterval(() => {
    const s = Math.max(0, Math.ceil((due - Date.now()) / 1000));
    count.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 100);

  try {
    const letter = await openWhenDue(armored, round, (n) => {
      if (current !== run) return;
      const status = $("#status");
      status.textContent = `Waiting for drand to publish round #${round}… (${n})`;
      status.hidden = false;
    }, run.abort.signal);
    await reveal(run, letter);
  } catch (err) {
    if (current === run && !run.opened) showErrors($("#errors"), [`This capsule can't be opened: ${(err as Error).message}`]);
  }
}

async function reveal(run: Run, text: string) {
  if (current !== run || run.opened) return;
  run.opened = true;
  clearInterval(ticker);
  $("#count").textContent = "0:00";
  $("#env").classList.add("opened");
  await sleep(1000);
  if (current !== run) return;
  show("opened");
  const proof = $("#proof");
  proof.hidden = true;
  await typewriter($("#letter"), text, 5000);
  if (current !== run) return;
  proof.innerHTML = `Opened by drand round <a target="_blank" rel="noreferrer"></a>`;
  const a = $<HTMLAnchorElement>("a", proof);
  a.href = beaconUrl(run.round);
  a.textContent = `#${run.round}`;
  proof.hidden = false;
  bringIntoView(proof);
}

$("#seal60").onclick = () => start(60);
$("#seal30").onclick = () => start(30);
$("#again").onclick = () => {
  current?.abort.abort();
  current = undefined;
  clearInterval(ticker);
  $("#letter").textContent = "";
  show("compose");
};
$("#try").onclick = async () => {
  const run = current;
  if (!run || run.opened) return;
  const btn = $<HTMLButtonElement>("#try");
  btn.disabled = true;
  const result = await tryOpenNow(run.armored, run.round);
  btn.disabled = false;
  if (current !== run || run.opened) return; // opened, or reset, while drand was answering
  if ("text" in result) return reveal(run, result.text);
  showErrors($("#errors"), result.errors);
};
