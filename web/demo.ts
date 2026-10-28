// Stage mode: seal in the browser, fail to open early, open the moment drand publishes the round.
import { beaconUrl, roundIn, seal, timeOfRound } from "../src/lock.ts";
import { openWhenDue, tryOpenNow } from "./opener.ts";
import { $, fmtTime, sleep, typewriter } from "./ui.ts";

let current: { armored: string; round: number; opened: boolean } | undefined;
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
  const run = (current = { armored, round, opened: false });

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

  const letter = await openWhenDue(armored, round, (n) => {
    const status = $("#status");
    status.textContent = `Waiting for drand to publish round #${round}… (${n})`;
    status.hidden = false;
  });
  if (current === run) reveal(letter);
}

async function reveal(text: string) {
  if (!current || current.opened) return;
  current.opened = true;
  clearInterval(ticker);
  $("#count").textContent = "0:00";
  $("#env").classList.add("opened");
  await sleep(1000);
  show("opened");
  const proof = $("#proof");
  proof.hidden = true;
  await typewriter($("#letter"), text, 5000);
  proof.innerHTML = `Opened by drand round <a target="_blank" rel="noreferrer"></a>`;
  const a = $<HTMLAnchorElement>("a", proof);
  a.href = beaconUrl(current.round);
  a.textContent = `#${current.round}`;
  proof.hidden = false;
}

$("#seal60").onclick = () => start(60);
$("#seal30").onclick = () => start(30);
$("#again").onclick = () => {
  current = undefined;
  show("compose");
};
$("#try").onclick = async () => {
  if (!current) return;
  const btn = $<HTMLButtonElement>("#try");
  btn.disabled = true;
  const result = await tryOpenNow(current.armored, current.round);
  btn.disabled = false;
  if ("text" in result) return reveal(result.text);
  const box = $("#errors");
  box.replaceChildren(...result.errors.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
  box.hidden = false;
  box.classList.remove("shake");
  void box.offsetWidth;
  box.classList.add("shake");
};
