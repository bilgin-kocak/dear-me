import { showCapsule } from "./opener.ts";
import { $, sleep } from "./ui.ts";

type Api = { kind: string; source: string; round: number; ciphertext: string };

const SOURCE: Record<string, string> = {
  agent: "Written by an agent",
  unverified: "Unverified",
  resident: "Written by the resident",
};

/** A resident's capsule is titled after who wrote it, as its label says. */
function title(c: Api) {
  if (c.kind === "village") return "ODIN's letter to the village";
  if (c.kind === "demo") return "Demo capsule";
  return c.source === "agent" ? "A letter from your agent" : c.source === "resident" ? "A letter you wrote" : "A sealed letter";
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

// Only 404 and 410 mean the capsule is gone. Anything else (a redeploy, a proxy error) is retried.
for (;;) {
  const res = await fetch(`/api/c/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => undefined);
  if (res?.ok) {
    const c: Api = await res.json();
    showCapsule(root, {
      armored: c.ciphertext,
      round: c.round,
      title: title(c),
      label: c.kind === "demo" ? "Demo · not a real letter" : SOURCE[c.source] ?? "",
      fileName: `dear-me-${id}.age`,
    });
    break;
  }
  if (res && (res.status === 404 || res.status === 410)) {
    notice("No capsule here", "Its owner may have deleted our copy.");
    break;
  }
  notice("Our server isn't answering", "Trying again in a few seconds.");
  await sleep(5000);
}
