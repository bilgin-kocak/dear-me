import { createHmac, randomBytes } from "node:crypto";

/** Keyed hash with a purpose prefix, so an owner hash can never equal an agent hash. */
export const saltedHash = (salt: string, purpose: "owner" | "agent" | "wall", value: string | number) =>
  createHmac("sha256", salt).update(`${purpose}:${value}`).digest("base64url");

/** 16 random bytes, base64url: the secret part of a capsule link. */
export const newCapsuleId = () => randomBytes(16).toString("base64url");
