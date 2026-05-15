import type { Channel } from "../types";

const KEY = "iptv-favorite-urls";

/** Stable key for a channel (stream URL). */
export function favoriteKeyForChannel(c: Pick<Channel, "url">): string {
  return c.url.trim();
}

export function loadFavoriteUrls(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string").map((u) => u.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function saveFavoriteUrls(urls: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...urls]));
  } catch {
    /* quota / private mode */
  }
}
