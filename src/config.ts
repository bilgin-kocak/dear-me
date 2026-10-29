import { roundForUnlock, timeOfRound } from "./lock.ts";

export type Config = ReturnType<typeof loadConfig>;

export const MAX_CHARS = 4000; // the longest letter we seal

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const port = Number(env.PORT ?? 3000);
  const botToken = env.TELEGRAM_BOT_TOKEN || undefined;
  const unlockAt = env.UNLOCK_AT ?? "2027-10-31T20:00:00+05:30";
  // Without an offset, Date.parse would read the time in the host's timezone (UTC on most servers).
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(unlockAt)) {
    throw new Error(`UNLOCK_AT needs a timezone offset, like 2027-10-31T20:00:00+05:30 (got ${unlockAt})`);
  }
  const unlockMs = Date.parse(unlockAt);
  if (Number.isNaN(unlockMs)) throw new Error(`UNLOCK_AT is not a date: ${unlockAt}`);
  const round = roundForUnlock(unlockMs);

  // The salt keys every owner and agent hash, so it must be secret and must never change.
  const hashSalt = env.HASH_SALT ?? "";
  if (botToken && (hashSalt.length < 16 || hashSalt.includes("replace-with"))) {
    throw new Error("HASH_SALT must be a long random secret when the bot runs, e.g. the output of: openssl rand -base64 32");
  }

  return {
    port,
    botToken,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    adminIds: new Set((env.ADMIN_TG_IDS ?? "").split(/[\s,]+/).filter(Boolean).map(Number)),
    round,
    unlockMs: timeOfRound(round),
    dbPath: env.DB_PATH ?? "data/dear-me.db",
    hashSalt: hashSalt || "dev-only-salt", // web-only runs hash nothing personal
    botUsername: undefined as string | undefined, // set once the bot has started
  };
}

const IST = "Asia/Kolkata";

/** "31 Oct 2027" */
export const dateIST = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric" }).format(ms);

/** "31 Oct 2027, 20:00 IST" */
export const dateTimeIST = (ms: number) =>
  `${dateIST(ms)}, ${new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms)} IST`;
