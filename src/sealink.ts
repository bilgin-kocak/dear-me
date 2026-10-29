// A seal link carries a letter from the resident's agent to /seal in the part after
// "#", which a browser never sends to any server. The page seals it on the resident's
// own device, so the letter itself never reaches us. Runs in Node and in the browser.

export const SEAL_PATH = "/seal";
const MAX_BYTES = 64 * 1024; // far more than any letter we seal: a hostile link stops inflating here

/**
 * The Python the agent runs, with `letter` already holding the letter. zlib makes the link
 * about 45% shorter, so the agent has less to copy, and its checksum catches a link damaged
 * on the way.
 * Standard base64, not base64url: an underscore can turn into italics on its way to Telegram.
 */
export const sealLinkPython = (origin: string) =>
  `import base64, zlib\nprint("${origin}${SEAL_PATH}#" + base64.b64encode(zlib.compress(letter.encode(), 9)).decode())`;

/** Runs bytes through a (de)compression stream. Null if they are damaged or grow past MAX_BYTES. */
async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array | null> {
  const writer = stream.writable.getWriter();
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const utf8 = (bytes: Uint8Array | null) => {
  try {
    return bytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

// A zlib stream starts with a deflate header whose two bytes are a multiple of 31.
const isZlib = (b: Uint8Array) => b.length > 6 && (b[0] & 0x0f) === 8 && b[0] >> 4 <= 7 && ((b[0] << 8) | b[1]) % 31 === 0;

/** The same link the Python makes, built in JavaScript (tests, examples). */
export async function sealLink(origin: string, letter: string): Promise<string> {
  const packed = (await through(new TextEncoder().encode(letter), new CompressionStream("deflate")))!;
  let binary = "";
  for (const byte of packed) binary += String.fromCharCode(byte);
  return `${origin}${SEAL_PATH}#${btoa(binary)}`;
}

/**
 * The letter in a seal link's fragment, or null if it isn't a readable one. Accepts what
 * agents actually send: base64 or base64url, with or without padding, percent-encoded
 * characters, line breaks from wrapping, and plain UTF-8 that was never compressed.
 */
export async function readSealLink(fragment: string): Promise<string | null> {
  let b64: string;
  try {
    b64 = decodeURIComponent(fragment.replace(/^#/, ""));
  } catch {
    return null;
  }
  b64 = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!b64 || !/^[A-Za-z0-9+/]+$/.test(b64) || b64.length % 4 === 1) return null;
  const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  // A damaged compressed link fails zlib's checksum, and its bytes are not text either.
  const text = (isZlib(bytes) ? utf8(await through(bytes, new DecompressionStream("deflate"))) : null) ?? utf8(bytes);
  return text?.trim() || null;
}
