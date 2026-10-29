import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHARS, type Config } from "./config.ts";
import type { Store } from "./db.ts";
import { newCapsuleId, saltedHash } from "./hash.ts";
import { CHAIN, canonicalCapsule, inspectCapsule } from "./lock.ts";
import type { Log } from "./log.ts";

type Page = "wall" | "capsule" | "open" | "demo" | "seal" | "ask";

/** Counts per fixed hour: at most `perIp` from one address and `total` from everyone. */
function hourlyLimit(perIp: number, total: number) {
  let windowStart = 0;
  let all = 0;
  const byIp = new Map<string, number>();
  return (ip: string) => {
    if (Date.now() - windowStart >= 3_600_000) {
      windowStart = Date.now();
      all = 0;
      byIp.clear();
    }
    const n = byIp.get(ip) ?? 0;
    if (n >= perIp || all >= total) return false;
    byIp.set(ip, n + 1);
    all++;
    return true;
  };
}

// The address behind Fly's or Render's proxy. Spoofable without a proxy, which the total limit covers.
const clientIp = (c: Context) =>
  c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "direct";

export function createWeb(
  cfg: Config,
  store: Store,
  // A village shares one Wi-Fi address, so the per-address limit is generous.
  opts: { pagesDir?: string; log?: Log; limits?: { perIp: number; total: number } } = {},
) {
  const { pagesDir = "dist/web", log = () => {}, limits = { perIp: 30, total: 600 } } = opts;
  const app = new Hono();
  const allowSeal = hourlyLimit(limits.perIp, limits.total);
  const unlockAt = new Date(cfg.unlockMs).toISOString();
  // A capsule sealed from a seal link has no Telegram owner: whoever holds its link owns it.
  const linkOwner = (id: string) => saltedHash(cfg.hashSalt, "owner", `link:${id}`);

  app.use("*", async (c, next) => {
    await next();
    // Capsule links are secrets: never leak them in a Referer header.
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
  });

  const page = (name: Page) => (c: Context) => {
    const file = join(pagesDir, `${name}.html`);
    if (!existsSync(file)) return c.text("Pages are not built yet. Run: npm run build", 503);
    return c.html(readFileSync(file, "utf8"));
  };

  app.get("/", (c) => c.redirect("/wall"));
  app.get("/wall", page("wall"));
  app.get("/open", page("open"));
  app.get("/demo", page("demo"));
  app.get("/ask", page("ask"));
  app.get("/seal", page("seal"));
  app.get("/c/:id", (c) => {
    c.header("X-Robots-Tag", "noindex");
    return page("capsule")(c);
  });
  app.get("/healthz", (c) => c.text("ok"));

  // Counts and timestamps only. The id here is a one-way wall id, not the capsule
  // link id: the wall must never hand out links that open letters after 2027.
  app.get("/api/wall", (c) => {
    const rows = store.wallRows();
    c.header("Cache-Control", "no-store");
    return c.json({
      realCount: rows.filter((r) => r.kind !== "demo").length,
      uniqueAgents: store.uniqueAgents(),
      demoCount: rows.filter((r) => r.kind === "demo").length,
      unlockAt,
      capsules: rows.map((r) => ({
        id: saltedHash(cfg.hashSalt, "wall", r.id).slice(0, 12),
        kind: r.kind,
        sealedAt: r.sealed_at,
        unlockAt: r.unlock_at,
      })),
    });
  });

  // Everything the capsule page needs to decrypt in the browser. The server never decrypts.
  app.get("/api/c/:id", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex");
    const cap = store.getCapsule(c.req.param("id"));
    if (!cap) return c.json({ error: "not_found" }, 404);
    if (cap.burned) return c.json({ error: "burned" }, 410);
    return c.json({
      kind: cap.kind,
      source: cap.source,
      round: cap.round,
      unlockAt: cap.unlock_at,
      sealedAt: cap.sealed_at,
      ciphertext: cap.ciphertext,
    });
  });

  // What the seal and ask pages need: the round to seal to, the limit, and the bot to fall back to.
  app.get("/api/config", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ unlockAt, round: cfg.round, maxChars: MAX_CHARS, bot: cfg.botUsername ?? null });
  });

  // A letter sealed in the resident's browser from a seal link. Only the ciphertext arrives here.
  app.post("/api/capsules", bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (Date.now() >= cfg.unlockMs) return c.json({ error: "sealing_closed" }, 410);
    if (!allowSeal(clientIp(c))) return c.json({ error: "rate_limited" }, 429);
    const body = await c.req.json().catch(() => null);
    const armored = typeof body?.ciphertext === "string" ? canonicalCapsule(body.ciphertext) : null;
    const info = armored ? inspectCapsule(armored) : null;
    // Sealed to our unlock round on quicknet, and no bigger than a 4,000-character letter needs
    // (12,000 bytes of UTF-8 at most, about 17,000 characters once armored).
    if (!armored || armored.length > 20_000 || info?.chainHash !== CHAIN.hash || info.round !== cfg.round) {
      return c.json({ error: "invalid_capsule" }, 400);
    }
    const id = newCapsuleId();
    store.insertCapsule({
      id,
      kind: "resident",
      ciphertext: armored,
      round: cfg.round,
      unlock_at: unlockAt,
      sealed_at: new Date().toISOString(),
      owner_hash: linkOwner(id),
      agent_hash: null,
      source: "link",
    });
    log("sealed", { kind: "resident", source: "link" });
    return c.json({ id, url: `${cfg.publicBaseUrl}/c/${id}`, round: cfg.round, unlockAt }, 201);
  });

  // Deletes our copy of a link-sealed capsule. Bot capsules are burned in the bot by their owner.
  app.delete("/api/c/:id", (c) => {
    const id = c.req.param("id");
    if (!store.burn(id, linkOwner(id))) return c.json({ error: "not_found" }, 404);
    log("burned", { source: "link" });
    return c.body(null, 204);
  });

  return app;
}
