import { $, countdown, fmtIST } from "./ui.ts";

type Kind = "resident" | "village" | "demo";
type WallCapsule = { id: string; kind: Kind; sealedAt: string; unlockAt: string };
type Wall = { realCount: number; uniqueAgents: number; demoCount: number; unlockAt: string; capsules: WallCapsule[] };

let firstRender = true;
let unlockAt = "";
let stopCountdown: (() => void) | undefined;

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** A small, stable tilt per envelope so the wall looks hand-placed. */
function tilt(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 9) - 4) * 0.6;
}

function envelope(c: WallCapsule) {
  const el = document.createElement("div");
  el.className = `env ${c.kind === "resident" ? "" : c.kind}`;
  el.dataset.id = c.id;
  el.style.setProperty("--tilt", `${tilt(c.id)}deg`);
  el.title = `Sealed ${fmtIST(Date.parse(c.sealedAt))}`;
  el.innerHTML = c.kind === "village"
    ? `<span class="seal"></span><span class="caption">ODIN's letter to the village</span>`
    : `<span class="seal"></span>`;
  if (!firstRender) {
    el.classList.add("new");
    setTimeout(() => el.classList.remove("new"), 1600);
  }
  return el;
}

/** Keeps envelopes already on the wall, adds new ones (animated), removes burned ones. Newest first. */
function sync(container: HTMLElement, list: WallCapsule[]) {
  const existing = new Map([...container.children].map((el) => [(el as HTMLElement).dataset.id, el]));
  container.replaceChildren(...list.map((c) => existing.get(c.id) ?? envelope(c)));
}

function render(w: Wall) {
  $("#headline").textContent = w.uniqueAgents > 0
    ? `${count(w.realCount, "letter", "letters")} from ${count(w.uniqueAgents, "agent", "agents")}`
    : count(w.realCount, "letter", "letters");
  if (w.unlockAt !== unlockAt) {
    unlockAt = w.unlockAt;
    $("#sub").textContent = `sealed until ${fmtIST(Date.parse(unlockAt))}`;
    stopCountdown?.();
    stopCountdown = countdown($("#countdown"), Date.parse(unlockAt));
  }

  const by = (kind: Kind) => w.capsules.filter((c) => c.kind === kind);
  sync($("#real"), [...by("village"), ...by("resident")]);
  sync($("#demo"), by("demo"));
  $("#demoRow").hidden = w.demoCount === 0;
  $("#empty").hidden = w.realCount > 0;
  fit();
  firstRender = false;
}

/** Picks the largest envelope size that keeps the whole wall on one projector screen, by measuring it. */
function fit() {
  const grid = $("#real");
  if (innerWidth < 600) return grid.style.setProperty("--env", "72px"); // phones scroll instead
  const root = document.documentElement;
  let size = 220;
  grid.style.setProperty("--env", `${size}px`);
  while (size > 40 && root.scrollHeight > root.clientHeight) {
    size -= 6;
    grid.style.setProperty("--env", `${size}px`);
  }
}

async function poll() {
  try {
    const res = await fetch("/api/wall", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
    $("#conn").textContent = "";
  } catch {
    $("#conn").textContent = "· reconnecting…";
  }
}

poll();
setInterval(poll, 10_000);
addEventListener("resize", fit);
