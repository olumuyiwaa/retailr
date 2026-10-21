/**
 * Opening hours and free slots. Pure functions (no database) so the time-zone maths can be tested on its own.
 * A "date" is a calendar day in the business's own time zone, written YYYY-MM-DD.
 */
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];
export interface Range { start: string; end: string } // "HH:MM"
export type Hours = Partial<Record<Day, Range[]>>;
export interface Span { start: number; end: number } // epoch ms

/** Slots start every half hour inside opening hours. */
export const SLOT_STEP_MINS = 30;
export const MAX_DAYS_AHEAD = 60;
export const DEFAULT_HOURS: Hours = Object.fromEntries((["mon", "tue", "wed", "thu", "fri"] as Day[]).map((d) => [d, [{ start: "09:00", end: "17:00" }]]));

export const validTimezone = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };
export const toMins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetMs(tz: string, utcMs: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant (epoch ms) when the wall clock in `tz` reads `date` + `mins` minutes after midnight. */
export function zonedToUtc(date: string, mins: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, mins);
  const guess = naive - offsetMs(tz, naive);
  return naive - offsetMs(tz, guess);
}

/** The calendar date and weekday in `tz` at an instant. */
export function localDate(utcMs: number, tz: string): { date: string; day: Day; mins: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, day: DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()], mins: +p.hour * 60 + +p.minute };
}

export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const timeLabel = (utcMs: number, tz: string) => {
  const l = localDate(utcMs, tz);
  return `${String(Math.floor(l.mins / 60)).padStart(2, "0")}:${String(l.mins % 60).padStart(2, "0")}`;
};

/** Start times (epoch ms) a customer can pick on `date`. */
export function freeSlots(o: {
  hours: Hours; tz: string; date: string; durationMins: number; capacity: number; booked: Span[]; now: number; noticeMs: number;
}): number[] {
  const weekday = DAYS[new Date(`${o.date}T00:00:00Z`).getUTCDay()];
  const out: number[] = [];
  for (const r of o.hours[weekday] ?? []) {
    for (let t = toMins(r.start); t + o.durationMins <= toMins(r.end); t += SLOT_STEP_MINS) {
      const start = zonedToUtc(o.date, t, o.tz), end = start + o.durationMins * 60_000;
      if (start < o.now + o.noticeMs) continue;
      if (o.booked.filter((b) => b.start < end && b.end > start).length >= o.capacity) continue;
      out.push(start);
    }
  }
  return out;
}
