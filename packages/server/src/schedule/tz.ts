/** Timezone-aware date/time helpers built on Intl (no external dependency). */

/** Local calendar date (YYYY-MM-DD) of `d` in the given IANA timezone. */
export function tzDate(tz: string, d: Date): string {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Minutes-since-midnight of `d` in the given IANA timezone (0..1439). */
export function tzMinutes(tz: string, d: Date): number {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d); // "HH:MM"
  const [h, m] = hm.split(":").map((s) => Number.parseInt(s, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Parse an "HH:MM" time-of-day to minutes-since-midnight, or null if invalid. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number.parseInt(match[1]!, 10);
  const m = Number.parseInt(match[2]!, 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}
