/** Displayed timestamp is HH:mm (seconds are noisy for the user); pass the
 * full `Date` alongside if you need ordering or a full-precision tooltip. */
export function formatTimeHHmm(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}
