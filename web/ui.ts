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

export function download(name: string, text: string, type = "application/octet-stream") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Scrolls just enough to show el: on a projector or a phone the newest line must be on screen. */
export const bringIntoView = (el: HTMLElement) =>
  el.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });

/**
 * Scrolls so the letter is in view at its full height, or from its top if it is taller
 * than the screen. scrollIntoView would measure the unfold animation's squashed box.
 */
export function revealInView(el: HTMLElement) {
  const top = el.getBoundingClientRect().top; // the unfold grows from the top edge, so this is exact
  const overflow = top + el.offsetHeight - innerHeight + 16;
  if (overflow > 0) scrollBy({ top: Math.min(overflow, top - 16), behavior: reducedMotion() ? "auto" : "smooth" });
}

/** Shows error lines in a box, shakes it and brings it into view. Always textContent. */
export function showErrors(box: HTMLElement, lines: string[]) {
  box.replaceChildren(...lines.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
  box.hidden = false;
  box.classList.remove("shake");
  void box.offsetWidth; // restart the animation
  box.classList.add("shake");
  bringIntoView(box);
}

/** Copies text, falling back to a hidden textarea where in-app browsers lack the clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    area.style.cssText = "position:fixed;top:0;opacity:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
