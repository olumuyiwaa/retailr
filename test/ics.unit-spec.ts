import { escapeText, foldLine, icsDate, renderFeed, FeedBooking } from "../src/calendar/ics";

const booking = (over: Partial<FeedBooking> = {}): FeedBooking => ({
  id: "b1", serviceName: "Haircut", variantName: null, startsAt: new Date("2026-10-26T08:00:00Z"), endsAt: new Date("2026-10-26T09:00:00Z"),
  status: "CONFIRMED", customerName: "Ada Obi", customerEmail: "ada@example.com", customerPhone: "0800", notes: null,
  updatedAt: new Date("2026-10-20T10:00:00Z"), createdAt: new Date("2026-10-20T10:00:00Z"), ...over,
});

describe("iCalendar output", () => {
  it("formats UTC instants", () => expect(icsDate("2026-10-26T08:00:00Z")).toBe("20261026T080000Z"));

  it("escapes text values", () => {
    const B = String.fromCharCode(92); // one backslash
    expect(escapeText(["x,y", "z;w"].join(B))).toBe("x" + B + ",y" + B + B + "z" + B + ";w");
    expect(escapeText("l1\nl2")).toBe("l1" + B + "nl2");
  });

  it("folds long lines at 75 bytes without splitting characters", () => {
    const line = "SUMMARY:" + "é".repeat(80);
    const folded = foldLine(line).split("\r\n");
    expect(folded.length).toBeGreaterThan(1);
    for (const [i, l] of folded.entries()) expect(Buffer.byteLength(i ? l.slice(1) : l, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.map((l, i) => (i ? l.slice(1) : l)).join("")).toBe(line);
  });

  it("renders events with stable UIDs, CRLF lines and a status per booking state", () => {
    const out = renderFeed({
      name: "Shop · Bookings", now: new Date("2026-10-21T00:00:00Z"),
      bookings: [booking(), booking({ id: "b2", status: "PENDING" }), booking({ id: "b3", status: "CANCELLED" }), booking({ id: "b4", status: "NO_SHOW", variantName: "Premium" })],
    });
    expect(out.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(out.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(out).toContain("UID:booking-b1@retailr");
    expect(out).toContain("DTSTART:20261026T080000Z");
    expect(out).toContain("DTEND:20261026T090000Z");
    expect(out).toContain("SUMMARY:Haircut · Ada Obi");
    expect(out).toContain("SUMMARY:Haircut (Premium) · Ada Obi");
    expect(out.match(/STATUS:CONFIRMED/g)).toHaveLength(1);
    expect(out.match(/STATUS:TENTATIVE/g)).toHaveLength(1);
    expect(out.match(/STATUS:CANCELLED/g)).toHaveLength(2);
    expect(out).not.toMatch(/[^\r]\n/); // every line break is CRLF
  });
});
