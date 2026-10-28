import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOrigin, combineOrigins } from "../src/origin.ts";

const resident = { id: 7, is_bot: false, first_name: "Asha" };

test("a forward from a bot is written by an agent", () => {
  const msg = {
    from: resident,
    forward_origin: { type: "user" as const, date: 0, sender_user: { id: 99, is_bot: true, first_name: "Juniper", username: "Juniper_AV_bot" } },
  };
  assert.deepEqual(classifyOrigin(msg), { source: "agent", agentUsername: "juniper_av_bot" });
});

test("a forward from a human is unverified, unless it is the resident's own message", () => {
  const other = { type: "user" as const, date: 0, sender_user: { id: 8, is_bot: false, first_name: "Ravi" } };
  assert.deepEqual(classifyOrigin({ from: resident, forward_origin: other }), { source: "unverified" });
  const own = { type: "user" as const, date: 0, sender_user: resident };
  assert.deepEqual(classifyOrigin({ from: resident, forward_origin: own }), { source: "resident" });
});

test("a forward from a hidden user is unverified", () => {
  const msg = { from: resident, forward_origin: { type: "hidden_user" as const, date: 0, sender_user_name: "Someone" } };
  assert.deepEqual(classifyOrigin(msg), { source: "unverified" });
});

test("a message with no forward origin is written by the resident", () => {
  assert.deepEqual(classifyOrigin({ from: resident }), { source: "resident" });
});

test("a multi-part letter keeps its label only if every part agrees", () => {
  const agent = { source: "agent" as const, agentUsername: "juniper_av_bot" };
  assert.deepEqual(combineOrigins([agent, agent, agent]), agent);
  assert.deepEqual(combineOrigins([agent, { source: "resident" }]), { source: "unverified" });
  assert.deepEqual(combineOrigins([agent, { source: "agent", agentUsername: "other_bot" }]), { source: "unverified" });
});
