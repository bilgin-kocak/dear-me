import { roundForUnlock, timeOfRound } from "./lock.ts";

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const port = Number(env.PORT ?? 3000);
  const botToken = env.TELEGRAM_BOT_TOKEN || undefined;
  const unlockAt = env.UNLOCK_AT ?? "2027-10-31T20:00:00+05:30";
  const unlockMs = Date.parse(unlockAt);
  if (Number.isNaN(unlockMs)) throw new Error(`UNLOCK_AT is not a date: ${unlockAt}`);
  const round = roundForUnlock(unlockMs);

  const hashSalt = env.HASH_SALT ?? (botToken ? "" : "dev-only-salt");
  if (!hashSalt) throw new Error("HASH_SALT must be set when the bot runs");

  return {
    port,
    botToken,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    adminIds: new Set((env.ADMIN_TG_IDS ?? "").split(/[\s,]+/).filter(Boolean).map(Number)),
    round,
    unlockMs: timeOfRound(round),
    dbPath: env.DB_PATH ?? "data/dear-me.db",
    hashSalt,
  };
}

const IST = "Asia/Kolkata";

/** "31 Oct 2027" */
export const dateIST = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric" }).format(ms);

/** "31 Oct 2027, 20:00 IST" */
export const dateTimeIST = (ms: number) =>
  `${dateIST(ms)}, ${new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms)} IST`;
