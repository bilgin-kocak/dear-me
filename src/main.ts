import { serve } from "@hono/node-server";
import { GrammyError } from "grammy";
import { setTimeout as sleep } from "node:timers/promises";
import { BOT_COMMANDS, createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { openStore } from "./db.ts";
import { stdoutLog as log } from "./log.ts";
import { createWeb } from "./web.ts";

// Log errors as one line. Node's default dump of an error object would include
// grammY's request URLs, and with them the bot token.
const brief = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
process.on("unhandledRejection", (err) => log("error", { where: "unhandled_rejection", error: brief(err) }));

const cfg = loadConfig();
const store = openStore(cfg.dbPath);

const server = serve({ fetch: createWeb(cfg, store, { log }).fetch, port: cfg.port }, (info) =>
  log("web_listening", { port: info.port, round: cfg.round }));

const bot = cfg.botToken ? createBot(cfg, store, log) : undefined;
let polling: Promise<void> | undefined;
let stopping = false;

// The pages never need Telegram, so a polling failure never stops the web server.
// 409 means another process polls with this token: the deployed bot (NODE_ENV=production)
// takes polling back within seconds, and any other run, like a laptop, gives it up.
function startBot() {
  if (!bot || stopping) return;
  polling = bot.start({
    onStart: (me) => {
      cfg.botUsername = me.username; // the pages point at the bot as the fallback
      log("bot_started", { bot: me.username });
    },
  }).catch((err) => {
    const conflict = err instanceof GrammyError && err.error_code === 409;
    log("error", { where: "bot_polling", error: brief(err) });
    if (stopping) return;
    if (conflict && process.env.NODE_ENV !== "production") {
      return log("bot_yielded", { reason: "another process polls with this bot token; serving the web pages only" });
    }
    setTimeout(startBot, conflict ? 5_000 : 30_000);
  });
}

if (bot) {
  await bot.api.setMyCommands(BOT_COMMANDS).catch((err) => log("error", { where: "set_commands", error: brief(err) }));
  startBot();
} else {
  log("bot_disabled", { reason: "TELEGRAM_BOT_TOKEN is not set; serving the web pages only" });
}

async function shutdown() {
  stopping = true;
  try {
    await bot?.stop();
    // stop() does not wait for an update in progress (a Seal halfway through); polling does.
    await Promise.race([polling, sleep(4000)]);
  } catch (err) {
    log("error", { where: "shutdown", error: brief(err) });
  } finally {
    server.close();
    store.close();
    process.exit(0);
  }
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
