import type { Channel } from "../types";

/** Strip extension noise and tidy spaces for a YouTube search string from library display name. */
export function youtubeSearchQueryFromTrackName(name: string): string {
  let s = String(name ?? "").trim();
  s = s.replace(
    /\.(mp3|mpga|mpeg|m4a|m4b|aac|flac|wav|ogg|oga|opus|webm|aiff?|wma)$/i,
    ""
  );
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 180);
}

/**
 * Local library blob row where we run LRCLIB + optional YouTube title + lyrics UI
 * (MP3/MPEG, FLAC, and similar file-backed `audio/*` from the library).
 */
export function isLikelyLocalMp3Channel(channel: Channel | null): boolean {
  if (!channel?.libraryTrackId?.trim()) return false;
  const url = channel.url?.trim().toLowerCase() ?? "";
  if (!url.startsWith("blob:")) return false;
  const mime = (channel.libraryContentType ?? "").toLowerCase();
  if (mime.includes("mpeg") || mime === "audio/mp3") return true;
  if (mime.includes("flac")) return true;
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("ogg") || mime.includes("opus")) return true;
  const lowerName = channel.name?.toLowerCase() ?? "";
  if (
    /\.(mp3|flac|m4a|m4b|aac|ogg|oga|opus|wav|webm|mpga|mpeg)$/i.test(lowerName)
  ) {
    return true;
  }
  return false;
}
