// /ask: the one prompt a resident sends their agent, ready to copy.
import { sealLinkPrompt } from "../src/prompt.ts";
import { $, copyText, fmtIST } from "./ui.ts";

const prompt = sealLinkPrompt(location.origin);
$("#prompt").textContent = prompt;

const copy = $<HTMLButtonElement>("#copy");
copy.onclick = async () => {
  copy.textContent = (await copyText(prompt)) ? "Copied. Now send it to your agent" : "Select the prompt and copy it";
  setTimeout(() => (copy.textContent = "Copy the prompt"), 3000);
};

try {
  const cfg: { unlockAt: string; bot: string | null } = await (await fetch("/api/config", { cache: "no-store" })).json();
  $("#date").textContent = fmtIST(Date.parse(cfg.unlockAt));
  if (cfg.bot) {
    const bot = $<HTMLAnchorElement>("#bot");
    bot.href = `https://t.me/${encodeURIComponent(cfg.bot)}`;
    bot.textContent = `@${cfg.bot}`;
    $("#fallback").hidden = false;
  }
} catch {
  // Offline: the default date stands, and the bot fallback stays hidden.
}
