import type { ListItem } from "@/list-db/migrations";

function formatPriority(priority: number): "Normal" | "High" | "Low" {
  switch (priority) {
    case 1:
      return "High";
    case -1:
      return "Low";
    default:
      return "Normal";
  }
}

function formatDate(timestamp: number | null): string | null {
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString();
}

function formatDuration(minutes: number | null): string | null {
  if (minutes === null) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function exportItemsToJson(items: ListItem[]): string {
  const exported = items.map((item) => ({
    title: item.title,
    type: item.type === "movie" ? "Movie" : "TV",
    priority: formatPriority(item.priority),
    rating: item.rating,
    duration: formatDuration(item.duration),
    episodes: item.episodeCount,
    releaseDate: formatDate(item.releaseDate),
    watchedAt: formatDate(item.watchedAt),
    tags: parseTags(item.tags),
    overview: item.overview,
    tmdbId: item.tmdbId,
    addedAt: new Date(item.createdAt).toISOString(),
    posterUrl: item.posterUrl,
  }));

  return JSON.stringify(exported, null, 2);
}

export function downloadJson(json: string, filename: string) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
