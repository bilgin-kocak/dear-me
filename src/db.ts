import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Kind = "resident" | "village" | "demo";
/** link: sealed in the resident's browser from their agent's seal link (see src/sealink.ts). */
export type Source = "agent" | "unverified" | "resident" | "link";

export type Capsule = {
  id: string;
  kind: Kind;
  ciphertext: string; // armored age; never plaintext
  round: number;
  unlock_at: string;
  sealed_at: string;
  owner_hash: string;
  agent_hash: string | null;
  source: Source;
  burned: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capsules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  round INTEGER NOT NULL,
  unlock_at TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  agent_hash TEXT,
  source TEXT NOT NULL,
  burned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS consents (
  owner_hash TEXT PRIMARY KEY,
  agreed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capsules_owner ON capsules (owner_hash, sealed_at);
`;

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("secure_delete = ON"); // a burned capsule is overwritten, not just unlinked
  db.exec(SCHEMA);

  const q = {
    insert: db.prepare(`INSERT INTO capsules (id, kind, ciphertext, round, unlock_at, sealed_at, owner_hash, agent_hash, source)
      VALUES (@id, @kind, @ciphertext, @round, @unlock_at, @sealed_at, @owner_hash, @agent_hash, @source)`),
    get: db.prepare(`SELECT * FROM capsules WHERE id = ?`),
    mine: db.prepare(`SELECT * FROM capsules WHERE owner_hash = ? AND burned = 0 ORDER BY sealed_at DESC`),
    burn: db.prepare(`UPDATE capsules SET burned = 1, ciphertext = '' WHERE id = ? AND owner_hash = ? AND burned = 0`),
    burnLink: db.prepare(`UPDATE capsules SET burned = 1, ciphertext = '' WHERE id = ? AND source = 'link' AND burned = 0`),
    linkByCiphertext: db.prepare(`SELECT id FROM capsules WHERE source = 'link' AND burned = 0 AND ciphertext = ?`),
    sealedSince: db.prepare(`SELECT COUNT(*) AS n FROM capsules WHERE owner_hash = ? AND kind != 'demo' AND burned = 0 AND sealed_at >= ?`),
    wall: db.prepare(`SELECT id, kind, sealed_at, unlock_at FROM capsules WHERE burned = 0 ORDER BY sealed_at DESC, rowid DESC`),
    // One agent per (resident, agent bot) pair, so a bot that serves many residents still counts once per
    // resident. A letter sealed from a seal link counts as one agent: only an agent running code makes the
    // link, and nothing tells us which agent it was.
    agents: db.prepare(`SELECT
      (SELECT COUNT(DISTINCT owner_hash || ':' || agent_hash) FROM capsules
        WHERE burned = 0 AND kind != 'demo' AND agent_hash IS NOT NULL) +
      (SELECT COUNT(*) FROM capsules WHERE burned = 0 AND kind != 'demo' AND source = 'link') AS n`),
    consent: db.prepare(`INSERT INTO consents (owner_hash, agreed_at) VALUES (?, ?) ON CONFLICT (owner_hash) DO NOTHING`),
    hasConsent: db.prepare(`SELECT 1 FROM consents WHERE owner_hash = ?`),
  };

  const checkpointIf = (changed: boolean) => {
    if (changed) db.pragma("wal_checkpoint(TRUNCATE)"); // don't leave the old row in the WAL either
    return changed;
  };

  return {
    insertCapsule: (c: Omit<Capsule, "burned">) => void q.insert.run(c),
    getCapsule: (id: string) => q.get.get(id) as Capsule | undefined,
    listMine: (ownerHash: string) => q.mine.all(ownerHash) as Capsule[],
    burn: (id: string, ownerHash: string) => checkpointIf(q.burn.run(id, ownerHash).changes > 0),
    /** A capsule sealed from a seal link has no Telegram owner: whoever holds its link owns it. */
    burnLink: (id: string) => checkpointIf(q.burnLink.run(id).changes > 0),
    /** The live link capsule with exactly this ciphertext, if one was stored already. */
    findLinkCapsule: (ciphertext: string) => (q.linkByCiphertext.get(ciphertext) as { id: string } | undefined)?.id,
    sealedSince: (ownerHash: string, sinceIso: string) => (q.sealedSince.get(ownerHash, sinceIso) as { n: number }).n,
    wallRows: () => q.wall.all() as Pick<Capsule, "id" | "kind" | "sealed_at" | "unlock_at">[],
    uniqueAgents: () => (q.agents.get() as { n: number }).n,
    addConsent: (ownerHash: string, at = new Date()) => void q.consent.run(ownerHash, at.toISOString()),
    hasConsent: (ownerHash: string) => q.hasConsent.get(ownerHash) !== undefined,
    close: () => db.close(),
  };
}
