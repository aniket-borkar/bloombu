/**
 * Parse an RFC3339 source timestamp without discarding exchange nanoseconds.
 * Pure JavaScript so the server and browser use the same ordering rules.
 */
export function sourceTimeNs(value: string | null | undefined): bigint | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes some impossible dates and 24:00 instead of rejecting them.
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const base = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone.toUpperCase()}`);
  if (!Number.isFinite(base)) return null;
  return BigInt(base) * 1_000_000n + BigInt(fraction.padEnd(9, "0"));
}
