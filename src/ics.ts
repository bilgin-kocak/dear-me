// A one-event iCalendar file (RFC 5545) reminding the owner when their letter opens.

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const text = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

/** Lines longer than 75 octets continue on the next line after a space. Content here is ASCII. */
function fold(line: string): string {
  const out = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) out.push(` ${line.slice(i, i + 74)}`);
  return out.join("\r\n");
}

export function calendarFile(opts: { url: string; startMs: number; nowMs?: number }): string {
  const { url, startMs, nowMs = Date.now() } = opts;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dear Me From Your Agent//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@dear-me`,
    `DTSTAMP:${stamp(nowMs)}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(startMs + 30 * 60_000)}`,
    `SUMMARY:${text("Open your letter from your agent")}`,
    `DESCRIPTION:${text(`Your Dear Me capsule unlocks now. Open it here: ${url}`)}`,
    `URL:${url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${text("Your letter from your agent unlocks now")}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}
