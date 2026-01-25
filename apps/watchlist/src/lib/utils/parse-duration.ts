export function parseDuration(durationStr: string | null): number | null {
  if (!durationStr) return null;

  const hoursMatch = durationStr.match(/(\d+)h/);
  const minutesMatch = durationStr.match(/(\d+)m/);

  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;

  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}
