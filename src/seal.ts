import type { Kind, Source, Store } from "./db.ts";
import { newCapsuleId } from "./hash.ts";
import { seal, timeOfRound } from "./lock.ts";

export type SealInput = {
  text: string;
  kind: Kind;
  round: number;
  ownerHash: string;
  agentHash: string | null;
  source: Source;
};

/**
 * Time-locks the letter and stores only the armored ciphertext. The caller must
 * drop its own reference to the text as soon as this returns.
 */
export async function sealCapsule(store: Store, input: SealInput) {
  const id = newCapsuleId();
  const ciphertext = await seal(input.text, input.round);
  if (!ciphertext.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")) {
    throw new Error("refusing to store something that is not an age file");
  }
  const unlockAt = new Date(timeOfRound(input.round)).toISOString();
  store.insertCapsule({
    id,
    kind: input.kind,
    ciphertext,
    round: input.round,
    unlock_at: unlockAt,
    sealed_at: new Date().toISOString(),
    owner_hash: input.ownerHash,
    agent_hash: input.agentHash,
    source: input.source,
  });
  return { id, ciphertext, round: input.round, unlockAt };
}
