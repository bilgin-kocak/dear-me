import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarFile } from "../src/ics.ts";

test("the calendar file opens at 20:00 IST on 31 Oct 2027 and carries the link", () => {
  const url = "https://dear-me.example.org/c/q2Xv6m0bS3uYF1aKc9ZlRw";
  const ics = calendarFile({ url, startMs: Date.parse("2027-10-31T20:00:00+05:30"), nowMs: 0 });
  assert.ok(ics.endsWith("\r\n"));
  const lines = ics.split("\r\n").slice(0, -1);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /\r\nDTSTART:20271031T143000Z\r\n/);
  assert.ok(unfolded.includes(`\r\nURL:${url}\r\n`));
  assert.ok(unfolded.includes(url.replace(/[,;]/g, "")));
});
