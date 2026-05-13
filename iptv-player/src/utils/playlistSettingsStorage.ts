const LAST_PLAYLIST_URL = "iptv-last-playlist-url";
const LAST_ACTIVE_CHANNEL_URL = "iptv-last-active-channel-url";

export function loadLastPlaylistUrl(): string {
  try {
    const v = localStorage.getItem(LAST_PLAYLIST_URL);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

export function saveLastPlaylistUrl(url: string | null): void {
  try {
    if (url?.trim()) localStorage.setItem(LAST_PLAYLIST_URL, url.trim());
    else localStorage.removeItem(LAST_PLAYLIST_URL);
  } catch {
    /* quota */
  }
}

export function loadLastActiveChannelUrl(): string {
  try {
    const v = localStorage.getItem(LAST_ACTIVE_CHANNEL_URL);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

export function saveLastActiveChannelUrl(url: string | null): void {
  try {
    if (url?.trim()) localStorage.setItem(LAST_ACTIVE_CHANNEL_URL, url.trim());
    else localStorage.removeItem(LAST_ACTIVE_CHANNEL_URL);
  } catch {
    /* noop */
  }
}
