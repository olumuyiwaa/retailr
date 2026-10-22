/** iCalendar (RFC 5545) for booking feeds. Pure functions, no I/O. */

const pad = (n: number) => String(n).padStart(2, "0");

/** 2026-10-10T08:00:00Z -> 20261010T080000Z */
export function icsDate(d: Date | string): string {
  const x = new Date(d);
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`;
}

/** TEXT values: escape backslash, semicolon, comma and newlines. */
export const escapeText = (v: unknown) => String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines may not exceed 75 octets: fold by bytes without splitting a multi-byte character, continuing with a leading space. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let current = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > limit) { parts.push(current); current = ""; bytes = 0; limit = 74; }
    current += ch;
    bytes += b;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

export interface FeedBooking {
  id: string; serviceName: string; variantName: string | null; startsAt: Date; endsAt: Date; status: string;
  customerName: string; customerEmail: string | null; customerPhone: string | null; notes: string | null; updatedAt: Date; createdAt: Date;
}

const STATUS: Record<string, string> = { CANCELLED: "CANCELLED", NO_SHOW: "CANCELLED", PENDING: "TENTATIVE" };

export function renderFeed({ name, bookings, now = new Date() }: { name: string; bookings: FeedBooking[]; now?: Date }): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Retailr//Calendar Feed//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const b of bookings) {
    const service = b.variantName ? `${b.serviceName} (${b.variantName})` : b.serviceName;
    const description = [
      `Customer: ${b.customerName}`,
      b.customerPhone && `Phone: ${b.customerPhone}`,
      b.customerEmail && `Email: ${b.customerEmail}`,
      b.notes && `Notes: ${b.notes}`,
      b.status === "PENDING" && "Waiting for your confirmation",
      b.status === "NO_SHOW" && "Marked as a no-show",
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:booking-${b.id}@retailr`,
      `DTSTAMP:${icsDate(now)}`,
      `LAST-MODIFIED:${icsDate(b.updatedAt)}`,
      // a changed event keeps its UID and gets a higher sequence, so calendar apps treat it as an update
      `SEQUENCE:${Math.floor(b.updatedAt.getTime() / 1000)}`,
      `DTSTART:${icsDate(b.startsAt)}`,
      `DTEND:${icsDate(b.endsAt)}`,
      `SUMMARY:${escapeText(`${service} · ${b.customerName}`)}`,
      `DESCRIPTION:${escapeText(description)}`,
      `STATUS:${STATUS[b.status] ?? "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
