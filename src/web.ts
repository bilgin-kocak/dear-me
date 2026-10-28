import { Hono, type Context } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { saltedHash } from "./hash.ts";

type Page = "wall" | "capsule" | "open" | "demo";

export function createWeb(cfg: Config, store: Store, pagesDir = "dist/web") {
  const app = new Hono();

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
      unlockAt: new Date(cfg.unlockMs).toISOString(),
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

  return app;
}
