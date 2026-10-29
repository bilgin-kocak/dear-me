import type { Message } from "grammy/types";
import type { Source } from "./db.ts";

export type Origin = { source: Source; agentUsername?: string };

export const SOURCE_LABEL: Record<Source, string> = {
  agent: "Written by an agent",
  unverified: "Unverified",
  resident: "Written by the resident",
  link: "Sealed from your agent's link",
};

/** Who wrote a message the resident sent us, judged only by Telegram's forward_origin. */
export function classifyOrigin(msg: Pick<Message, "forward_origin" | "from">): Origin {
  const origin = msg.forward_origin;
  if (!origin) return { source: "resident" };
  if (origin.type === "user") {
    const sender = origin.sender_user;
    if (sender.is_bot) return { source: "agent", agentUsername: (sender.username ?? String(sender.id)).toLowerCase() };
    if (sender.id === msg.from?.id) return { source: "resident" }; // they forwarded their own message
  }
  return { source: "unverified" }; // hidden_user, another human, a chat or a channel
}

/** A letter in several parts keeps its label only if every part agrees. */
export function combineOrigins(origins: Origin[]): Origin {
  const [first] = origins;
  const same = origins.every((o) => o.source === first.source && o.agentUsername === first.agentUsername);
  return same ? first : { source: "unverified" };
}
