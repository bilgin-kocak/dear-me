import { CHAIN, canonicalCapsule, inspectCapsule } from "../src/lock.ts";
import { showCapsule } from "./opener.ts";
import { $ } from "./ui.ts";

const area = $<HTMLTextAreaElement>("#armored");
const file = $<HTMLInputElement>("#file");
let dispose: (() => void) | undefined;

$("#pick").onclick = () => file.click();
file.onchange = async () => {
  const f = file.files?.[0];
  if (!f) return;
  // Bytes, not text: a binary age file (tle's default) would be mangled by UTF-8 decoding.
  const bytes = new Uint8Array(await f.arrayBuffer());
  area.value = canonicalCapsule(bytes) ?? new TextDecoder().decode(bytes);
  file.value = ""; // choosing the same file again still fires change
  go(f.name);
};
$("#go").onclick = () => go();

function go(fileName = "capsule.age") {
  const problem = $("#problem");
  problem.hidden = true;
  dispose?.();
  dispose = undefined;
  $("#capsule").replaceChildren();
  const armored = canonicalCapsule(area.value);
  const info = armored && inspectCapsule(armored);
  if (!armored || !info) {
    problem.textContent = "That isn't a tlock capsule. Paste the whole file, from the BEGIN line to the END line.";
    problem.hidden = false;
    return;
  }
  if (info.chainHash !== CHAIN.hash) {
    problem.textContent = `This capsule was sealed on another drand chain (${info.chainHash.slice(0, 12)}…), not quicknet.`;
    problem.hidden = false;
    return;
  }
  dispose = showCapsule($("#capsule"), {
    armored,
    round: info.round,
    title: "A sealed capsule",
    label: "Locked with drand timelock encryption",
    fileName,
  });
  $("#capsule").scrollIntoView({ behavior: "smooth", block: "start" });
}
