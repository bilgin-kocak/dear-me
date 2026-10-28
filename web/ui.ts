// Small browser helpers: DOM, IST formatting, countdowns, the typewriter reveal.

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const IST = "Asia/Kolkata";
export const fmtDate = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric" }).format(ms);
export const fmtTime = (ms: number, seconds = false) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: IST, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hourCycle: "h23",
  }).format(ms) + " IST";
export const fmtIST = (ms: number) => `${fmtDate(ms)} · ${fmtTime(ms)}`;

/** Days, hours, minutes and seconds until targetMs. Calls onDone once when it reaches zero. */
export function countdown(el: HTMLElement, targetMs: number, onDone?: () => void) {
  el.classList.add("countdown");
  el.innerHTML = ["days", "hours", "minutes", "seconds"]
    .map((u) => `<div class="cd-unit"><span class="cd-num">00</span><span class="cd-label">${u}</span></div>`)
    .join("");
  const nums = [...el.querySelectorAll<HTMLElement>(".cd-num")];
  const tick = () => {
    const left = Math.max(0, targetMs - Date.now());
    const s = Math.ceil(left / 1000);
    [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].forEach((v, i) => {
      const txt = String(v).padStart(2, "0");
      if (nums[i].textContent !== txt) nums[i].textContent = txt;
    });
    if (left === 0) {
      clearInterval(timer);
      onDone?.();
    }
  };
  const timer = setInterval(tick, 200);
  tick();
  return () => clearInterval(timer);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Types the letter out in about `totalMs`. Always textContent: a letter is never HTML. */
export async function typewriter(el: HTMLElement, text: string, totalMs = 6000) {
  if (reducedMotion()) {
    el.textContent = text;
    return;
  }
  const chars = Array.from(text);
  const perFrame = Math.max(1, Math.ceil(chars.length / (totalMs / 16)));
  el.textContent = "";
  for (let i = 0; i < chars.length; i += perFrame) {
    el.textContent += chars.slice(i, i + perFrame).join("");
    await new Promise(requestAnimationFrame);
  }
}

export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
