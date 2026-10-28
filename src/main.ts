import { serve } from "@hono/node-server";
import { BOT_COMMANDS, createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { openStore } from "./db.ts";
import { stdoutLog as log } from "./log.ts";
import { createWeb } from "./web.ts";

const cfg = loadConfig();
const store = openStore(cfg.dbPath);

const server = serve({ fetch: createWeb(cfg, store).fetch, port: cfg.port }, (info) =>
  log("web_listening", { port: info.port, round: cfg.round }));

const bot = cfg.botToken ? createBot(cfg, store, log) : undefined;
if (bot) {
  await bot.api.setMyCommands(BOT_COMMANDS).catch(() => log("error", { where: "set_commands" }));
  bot.start({ onStart: (me) => log("bot_started", { bot: me.username }) }).catch((err) => {
    log("error", { where: "bot_start", error: err instanceof Error ? err.message : "unknown" });
    process.exit(1);
  });
} else {
  log("bot_disabled", { reason: "TELEGRAM_BOT_TOKEN is not set; serving the web pages only" });
}

async function shutdown() {
  await bot?.stop();
  server.close();
  store.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
