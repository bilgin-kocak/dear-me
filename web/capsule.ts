import { showCapsule } from "./opener.ts";
import { $, sleep } from "./ui.ts";

type Api = { kind: string; source: string; round: number; ciphertext: string };

const SOURCE: Record<string, string> = {
  agent: "Written by an agent",
  unverified: "Unverified",
  resident: "Written by the resident",
  link: "Sealed from your agent's link",
};

/** A resident's capsule is titled after who wrote it, as its label says. */
function title(c: Api) {
  if (c.kind === "village") return "ODIN's letter to the village";
  if (c.kind === "demo") return "Demo capsule";
  if (c.source === "agent" || c.source === "link") return "A letter from your agent";
  return c.source === "resident" ? "A letter you wrote" : "A sealed letter";
}

const id = decodeURIComponent(location.pathname.split("/").pop() ?? "");
const root = $("#capsule");

function notice(heading: string, text: string) {
  if ($("h1", root)?.textContent === heading) return; // already shown: keep the reader's focus
  root.innerHTML = `
    <div class="env big"><span class="seal"></span></div>
    <h1 class="title"></h1>
    <p class="muted"><span></span> If you have the <code>.age</code> file, you can also open it at <a href="/open">/open</a>.</p>`;
  $("h1", root).textContent = heading;
  $("p span", root).textContent = text;
}

/**
 * A capsule sealed from a seal link has no Telegram owner, so its link is what owns it:
 * whoever holds the link can delete our copy here. Two taps, no dialog: in-app browsers
 * handle confirm() unevenly.
 */
function offerDelete(dispose: () => void) {
  const manage = $("#manage");
  const btn = $<HTMLButtonElement>("#delete");
  const hint = $("#deleteHint");
  manage.hidden = false;
  let armedUntil = 0;
  btn.onclick = async () => {
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + 5000;
      btn.textContent = "Tap again to delete";
      hint.textContent = "This link will stop working. A downloaded .age file still opens the letter on the unlock date.";
      setTimeout(() => {
        if (Date.now() > armedUntil) btn.textContent = "Delete our copy";
      }, 5100);
      return;
    }
    btn.disabled = true;
    const res = await fetch(`/api/c/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    btn.disabled = false;
    if (res && (res.status === 204 || res.status === 404)) {
      dispose();
      manage.hidden = true;
      return notice("Our copy is deleted", "This link no longer opens anything.");
    }
    armedUntil = 0;
    btn.textContent = "Delete our copy";
    hint.textContent = "Our server isn't answering. Try again in a moment.";
  };
}

// Only 404 and 410 mean the capsule is gone. Anything else (a redeploy, a proxy error) is retried.
for (;;) {
  const res = await fetch(`/api/c/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => undefined);
  if (res?.ok) {
    const c: Api = await res.json();
    const dispose = showCapsule(root, {
      armored: c.ciphertext,
      round: c.round,
      title: title(c),
      label: c.kind === "demo" ? "Demo · not a real letter" : SOURCE[c.source] ?? "",
      fileName: `dear-me-${id}.age`,
    });
    if (c.source === "link") offerDelete(dispose);
    break;
  }
  if (res && (res.status === 404 || res.status === 410)) {
    notice("No capsule here", "Its owner may have deleted our copy.");
    break;
  }
  notice("Our server isn't answering", "Trying again in a few seconds.");
  await sleep(5000);
}
