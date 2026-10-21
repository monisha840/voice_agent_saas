/**
 * Day buckets for dashboard charts. Days are calendar days where the business is (BUSINESS_TIME_ZONE, the same
 * setting site-visit slots use), not UTC days, so "today" on a chart matches the customer's today.
 */
export function dashboardTimeZone(): string {
  return process.env.BUSINESS_TIME_ZONE?.trim() || "Asia/Kolkata";
}

/** YYYY-MM-DD of an instant in a time zone. */
export function zonedDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The instant the wall clock in `timeZone` shows 00:00 on the given YYYY-MM-DD. */
function zonedMidnight(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(guess - (shown - guess));
}

/** Start of the window that covers today and the `days - 1` calendar days before it, in `timeZone`. */
export function startOfDayWindow(now: Date, days: number, timeZone: string): Date {
  const today = zonedDay(now, timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, d - (days - 1)));
  return zonedMidnight(first.toISOString().slice(0, 10), timeZone);
}

/** One entry per calendar day of the window (oldest first), taking counts from `rows` and `empty` for missing days. */
export function fillDays<T extends Record<string, number>>(
  rows: ReadonlyArray<{ day: string } & T>,
  from: Date,
  days: number,
  timeZone: string,
  empty: T,
): Array<{ day: string } & T> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const [y, m, d] = zonedDay(from, timeZone).split("-").map(Number);
  const out: Array<{ day: string } & T> = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    const row = byDay.get(day);
    const values = { ...empty };
    if (row) for (const k of Object.keys(empty) as Array<keyof T>) values[k] = Number(row[k]) as T[keyof T];
    out.push({ day, ...values });
  }
  return out;
}
