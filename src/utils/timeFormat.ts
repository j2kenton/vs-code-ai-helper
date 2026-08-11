/** Displayed timestamp is HH:mm (seconds are noisy for the user); pass the
 * full `Date` alongside if you need ordering or a full-precision tooltip. */
export function formatTimeHHmm(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Shared display rule for chat messages and notification rows: a timestamp
 * from today shows as HH:mm; anything from an earlier (or later) calendar
 * day shows as the full date, year-first (`YYYY-MM-DD`), because a bare
 * time is meaningless once the day has changed. Assembled from local date
 * parts rather than `toLocaleDateString` so the format is deterministic
 * across locales. `now` is injectable for tests. */
export function formatTimestampForDisplay(date: Date, now: Date = new Date()): string {
  const sameCalendarDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameCalendarDay) {
    return formatTimeHHmm(date);
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
