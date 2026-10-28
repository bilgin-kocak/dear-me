import { showCapsule } from "./opener.ts";
import { $ } from "./ui.ts";

const TITLE: Record<string, string> = {
  resident: "A letter from your agent",
  village: "ODIN's letter to the village",
  demo: "Demo capsule",
};
const SOURCE: Record<string, string> = {
  agent: "Written by an agent",
  unverified: "Unverified",
  resident: "Written by the resident",
};

const id = decodeURIComponent(location.pathname.split("/").pop() ?? "");
const root = $("#capsule");
const res = await fetch(`/api/c/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => undefined);

if (res?.ok) {
  const c = await res.json();
  showCapsule(root, {
    armored: c.ciphertext,
    round: c.round,
    title: TITLE[c.kind] ?? TITLE.resident,
    label: c.kind === "demo" ? "Demo · not a real letter" : SOURCE[c.source] ?? "",
    fileName: `dear-me-${id}.age`,
  });
} else {
  root.innerHTML = `
    <div class="env big"><span class="seal"></span></div>
    <h1 class="title">No capsule here</h1>
    <p class="muted">${res ? "Its owner may have deleted our copy. " : "Our server can't be reached right now. "}
    If you have the <code>.age</code> file, you can still open it at <a href="/open">/open</a>.</p>`;
}
