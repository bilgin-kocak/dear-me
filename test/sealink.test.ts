// The seal link: the Python an agent runs, and the page's reader, against each other.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { LETTER_PROMPT, sealLinkPrompt } from "../src/prompt.ts";
import { readSealLink, SEAL_PATH, sealLink, sealLinkPython } from "../src/sealink.ts";

const ORIGIN = "https://dear-me.test";
const LETTER = `Dear Asha,

Three weeks ago you arrived in Mandrem saying you wanted to finish the novel about your grandmother's tea estate. You said "by December" twice, so I'm holding you to it. नमस्ते from the beach at sunrise 🌊

Three questions for October 2027: Did Meera read it? What did you cut? Who sat with you on the last night?

Juniper`;

let python: string | undefined;
try {
  execFileSync("python3", ["--version"]);
  python = "python3";
} catch {
  // no Python here: the Python tests are skipped
}

/** Runs the prompt's exact Python the way an agent does, with the letter in a variable called letter. */
function agentLink(letter: string) {
  const code = `letter = open(0, encoding="utf-8").read()\n${sealLinkPython(ORIGIN)}`;
  return execFileSync(python!, ["-I", "-c", code], { input: letter }).toString().trim();
}
const fragmentOf = (link: string) => link.slice(link.indexOf("#") + 1);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("the prompt is section 6, then the seal link instruction with this site's link", () => {
  const prompt = sealLinkPrompt(ORIGIN);
  assert.ok(prompt.startsWith(LETTER_PROMPT));
  assert.match(prompt, /Put it in a Python variable called letter, run this code, and reply with only the link it prints/);
  assert.ok(prompt.includes(`print("${ORIGIN}${SEAL_PATH}#"`));
});

test("the link the agent's Python prints opens to the exact letter", { skip: !python && "python3 not found" }, async () => {
  for (const letter of [LETTER, "Dear Ravi,\nshort and sweet.\n— Juniper\n", "x".repeat(4000)]) {
    const link = agentLink(letter);
    assert.ok(link.startsWith(`${ORIGIN}${SEAL_PATH}#`), link.slice(0, 40));
    assert.ok(!link.includes("_"), "no underscores: Markdown would turn them into italics");
    assert.equal(await readSealLink(fragmentOf(link)), letter.trim());
  }
});

test("a 300-word letter fits in one Telegram message", { skip: !python && "python3 not found" }, () => {
  const words = LETTER.split(/\s+/);
  const letter = Array.from({ length: 300 }, (_, i) => words[(i * 7) % words.length]).join(" ");
  const link = agentLink(letter);
  assert.ok(link.length < 4096, `${link.length} characters`);
  assert.ok(link.length < Buffer.from(letter).toString("base64").length, "zlib makes it shorter than plain base64");
});

test("the JavaScript link reads back too", async () => {
  const link = await sealLink(ORIGIN, LETTER);
  assert.equal(await readSealLink(`#${fragmentOf(link)}`), LETTER.trim());
});

test("links come back the way apps and agents mangle them", async () => {
  const frag = fragmentOf(await sealLink(ORIGIN, LETTER));
  const plain = new TextEncoder().encode(LETTER);
  const variants = {
    percentEncoded: encodeURIComponent(frag),
    base64url: frag.replace(/\+/g, "-").replace(/\//g, "_"),
    unpadded: frag.replace(/=+$/, ""),
    wrapped: frag.replace(/(.{64})/g, "$1\n"),
    neverCompressed: b64(plain),
    neverCompressedBase64url: Buffer.from(plain).toString("base64url"),
  };
  for (const [name, fragment] of Object.entries(variants)) assert.equal(await readSealLink(fragment), LETTER.trim(), name);
});

test("a damaged link is refused, never read as gibberish", async () => {
  const frag = fragmentOf(await sealLink(ORIGIN, LETTER));
  const mid = Math.floor(frag.length / 2);
  const swap = (c: string) => (c === "A" ? "B" : "A");
  const bomb = new Response(new Blob([new Uint8Array(1 << 20)]).stream().pipeThrough(new CompressionStream("deflate")));
  const damaged = {
    truncated: frag.slice(0, -8),
    changedCharacter: frag.slice(0, mid) + swap(frag[mid]) + frag.slice(mid + 1),
    droppedCharacter: frag.slice(0, mid) + frag.slice(mid + 1),
    empty: "",
    hashOnly: "#",
    notBase64: "this is not a letter!",
    badPercent: "%E0%A4%A",
    notText: b64(new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x81, 0x82, 0x83])),
    onlySpaces: b64(new TextEncoder().encode("   \n  ")),
    zipBomb: b64(new Uint8Array(await bomb.arrayBuffer())),
  };
  for (const [name, fragment] of Object.entries(damaged)) assert.equal(await readSealLink(fragment), null, name);
});
