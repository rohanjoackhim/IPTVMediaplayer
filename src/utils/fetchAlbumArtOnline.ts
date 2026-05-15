import type { ExtractedCover } from "./extractEmbeddedCoverArt";

export interface AlbumArtLookup {
  artist: string;
  title: string;
  album?: string;
}

export interface OnlineAlbumArtResult {
  ok: boolean;
  mime?: string;
  /** Raw image bytes from main process. */
  data?: ArrayBuffer;
}

/**
 * Desktop: iTunes Search API + artwork CDN (no API key). Returns null in browser-only builds.
 */
export async function fetchAlbumArtFromInternet(
  lookup: AlbumArtLookup
): Promise<ExtractedCover | null> {
  const ipc = typeof window !== "undefined" ? window.iptv?.fetchAlbumArtOnline : undefined;
  if (typeof ipc !== "function") return null;

  const artist = lookup.artist.trim();
  const title = lookup.title.trim();
  const album = lookup.album?.trim() ?? "";
  if (!artist && !title && !album) return null;

  let raw: unknown;
  try {
    raw = await ipc({ artist, title, album: album || undefined });
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as OnlineAlbumArtResult;
  if (!o.ok || !o.data || !(o.data instanceof ArrayBuffer) || o.data.byteLength < 32) return null;
  const mime =
    typeof o.mime === "string" && o.mime.trim().toLowerCase().startsWith("image/")
      ? o.mime.trim()
      : "image/jpeg";
  const n = Math.min(o.data.byteLength, 512 * 1024);
  const blob = new Blob([o.data.slice(0, n)], { type: mime });
  if (blob.size < 32) return null;
  return { blob, mime };
}
