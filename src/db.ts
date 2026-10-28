import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Kind = "resident" | "village" | "demo";
export type Source = "agent" | "unverified" | "resident";

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
    sealedSince: db.prepare(`SELECT COUNT(*) AS n FROM capsules WHERE owner_hash = ? AND kind != 'demo' AND sealed_at >= ?`),
    wall: db.prepare(`SELECT id, kind, sealed_at, unlock_at FROM capsules WHERE burned = 0 ORDER BY sealed_at DESC, rowid DESC`),
    // One agent per (resident, agent bot) pair, so a bot that serves many residents still counts once per resident.
    agents: db.prepare(`SELECT COUNT(DISTINCT owner_hash || ':' || agent_hash) AS n FROM capsules
      WHERE burned = 0 AND kind != 'demo' AND agent_hash IS NOT NULL`),
    consent: db.prepare(`INSERT INTO consents (owner_hash, agreed_at) VALUES (?, ?) ON CONFLICT (owner_hash) DO NOTHING`),
    hasConsent: db.prepare(`SELECT 1 FROM consents WHERE owner_hash = ?`),
  };

  return {
    insertCapsule: (c: Omit<Capsule, "burned">) => void q.insert.run(c),
    getCapsule: (id: string) => q.get.get(id) as Capsule | undefined,
    listMine: (ownerHash: string) => q.mine.all(ownerHash) as Capsule[],
    burn(id: string, ownerHash: string): boolean {
      const changed = q.burn.run(id, ownerHash).changes > 0;
      if (changed) db.pragma("wal_checkpoint(TRUNCATE)"); // don't leave the old row in the WAL either
      return changed;
    },
    sealedSince: (ownerHash: string, sinceIso: string) => (q.sealedSince.get(ownerHash, sinceIso) as { n: number }).n,
    wallRows: () => q.wall.all() as Pick<Capsule, "id" | "kind" | "sealed_at" | "unlock_at">[],
    uniqueAgents: () => (q.agents.get() as { n: number }).n,
    addConsent: (ownerHash: string, at = new Date()) => void q.consent.run(ownerHash, at.toISOString()),
    hasConsent: (ownerHash: string) => q.hasConsent.get(ownerHash) !== undefined,
    close: () => db.close(),
  };
}
