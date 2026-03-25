import { format } from "date-fns";

export function formatDateTimeLocal(timestamp: number) {
  return format(timestamp, "yyyy-MM-dd'T'HH:mm");
}

export function formatDateTimeDisplay(timestamp: number) {
  return format(timestamp, "MMM d, yyyy HH:mm");
}

export function parseDateTimeLocal(value: string) {
  const timestamp = new Date(value).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error("Please enter a valid date and time.");
  }

  return timestamp;
}
