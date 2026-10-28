// drand quicknet + tlock helpers. Runs in Node and in the browser.
import {
  timelockEncrypt, timelockDecrypt, roundAt, roundTime,
  defaultChainInfo, HttpChainClient, Buffer,
} from "tlock-js";
import type { ChainClient } from "tlock-js";

export const CHAIN = defaultChainInfo; // quicknet, 3-second rounds
export const RELAYS = [
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
  "https://drand.cloudflare.com",
];

export const beaconUrl = (round: number, relay = RELAYS[0]) =>
  `${relay}/${CHAIN.hash}/public/${round}`;

/**
 * A drand client with the quicknet chain info pinned in code. Sealing needs no
 * network at all; opening fetches exactly one beacon, which drand-client
 * verifies against the pinned public key before tlock uses it.
 */
export function quicknet(relay = RELAYS[0]): ChainClient {
  const chain = { baseUrl: `${relay}/${CHAIN.hash}`, info: async () => CHAIN };
  return new HttpChainClient(chain, { disableBeaconVerification: false, noCache: true });
}

export const timeOfRound = (round: number) => roundTime(CHAIN, round);

/** First round published at or after `ms`, so a letter never opens early. */
export function roundForUnlock(ms: number): number {
  const round = roundAt(ms, CHAIN);
  return timeOfRound(round) < ms ? round + 1 : round;
}

/** The round `seconds` from now, as the demo page does it. */
export const roundIn = (seconds: number, now = Date.now()) => roundAt(now + seconds * 1000, CHAIN);

export function seal(text: string, round: number, client = quicknet()): Promise<string> {
  return timelockEncrypt(round, Buffer.from(text, "utf8"), client);
}

export async function open(armored: string, client = quicknet()): Promise<string> {
  return (await timelockDecrypt(armored, client)).toString("utf8");
}

export const isTooEarly = (err: unknown) => /too early/i.test(String((err as Error)?.message));

/** Like open(), but falls back to other drand relays if one is down. */
export async function openAnywhere(armored: string): Promise<string> {
  let lastErr: unknown;
  for (const relay of RELAYS) {
    try {
      return await open(armored, quicknet(relay));
    } catch (err) {
      if (isTooEarly(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Reads the round and chain from an armored tlock capsule without decrypting it. */
export function inspectCapsule(armored: string): { round: number; chainHash: string } | null {
  const b64 = armored
    .replace(/-----(BEGIN|END) AGE ENCRYPTED FILE-----/g, "")
    .replace(/\s+/g, "");
  const header = Buffer.from(b64, "base64").subarray(0, 600).toString("latin1");
  const m = header.match(/^-> tlock (\d+) ([0-9a-f]{64})$/m);
  return m ? { round: Number(m[1]), chainHash: m[2] } : null;
}
