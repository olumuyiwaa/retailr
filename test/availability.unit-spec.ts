import { addDays, freeSlots, localDate, timeLabel, validDate, zonedToUtc } from "../src/bookings/availability";

const hours = { mon: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "15:00" }] };

describe("booking availability maths", () => {
  it("converts local wall-clock time to UTC", () => {
    expect(new Date(zonedToUtc("2026-10-26", 9 * 60, "Africa/Lagos")).toISOString()).toBe("2026-10-26T08:00:00.000Z"); // UTC+1
    expect(new Date(zonedToUtc("2026-10-26", 9 * 60, "Africa/Nairobi")).toISOString()).toBe("2026-10-26T06:00:00.000Z"); // UTC+3
    expect(new Date(zonedToUtc("2026-07-01", 9 * 60, "America/New_York")).toISOString()).toBe("2026-07-01T13:00:00.000Z"); // summer time
    expect(new Date(zonedToUtc("2026-01-01", 9 * 60, "America/New_York")).toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });

  it("reads the local date, weekday and time back", () => {
    const l = localDate(Date.parse("2026-10-25T23:30:00Z"), "Africa/Lagos"); // 00:30 Monday in Lagos
    expect(l).toEqual({ date: "2026-10-26", day: "mon", mins: 30 });
    expect(timeLabel(Date.parse("2026-10-26T08:00:00Z"), "Africa/Lagos")).toBe("09:00");
  });

  it("lists half-hourly starts that fit inside each opening range", () => {
    const base = { hours, tz: "Africa/Lagos", date: "2026-10-26", durationMins: 60, capacity: 1, booked: [], now: 0, noticeMs: 0 };
    const labels = (o = {}) => freeSlots({ ...base, ...o }).map((t) => timeLabel(t, "Africa/Lagos"));
    expect(labels()).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "13:00", "13:30", "14:00"]);
    expect(labels({ date: "2026-10-27" })).toEqual([]); // Tuesday is closed
  });

  it("drops booked slots up to capacity, and slots inside the notice period", () => {
    const at = (h: number, m = 0) => zonedToUtc("2026-10-26", h * 60 + m, "Africa/Lagos");
    const base = { hours, tz: "Africa/Lagos", date: "2026-10-26", durationMins: 60, capacity: 1, now: 0, noticeMs: 0 };
    const booked = [{ start: at(10), end: at(11) }];
    const labels = (o = {}) => freeSlots({ ...base, booked, ...o }).map((t) => timeLabel(t, "Africa/Lagos"));
    expect(labels()).toEqual(["09:00", "11:00", "13:00", "13:30", "14:00"]); // 09:30, 10:00, 10:30 overlap the booking
    expect(labels({ capacity: 2 })).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "13:00", "13:30", "14:00"]);
    expect(labels({ now: at(9), noticeMs: 2 * 3_600_000 })).toEqual(["11:00", "13:00", "13:30", "14:00"]);
  });

  it("validates dates", () => {
    expect(validDate("2026-02-29")).toBe(false);
    expect(validDate("2026-10-26")).toBe(true);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});
