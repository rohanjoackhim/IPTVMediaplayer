/**
 * Container MIME hints for native `<video>` / `<source type>` — Chromium uses these
 * when opening `file:` / `blob:` URLs (especially AVI, Matroska, MPEG program stream).
 */
export function mimeHintForLocalVideoFilename(filename: string): string | undefined {
  const base = filename.trim().toLowerCase().split(/[?#]/)[0] ?? "";
  if (/\.(avi|divx)$/.test(base)) return "video/x-msvideo";
  if (/\.mkv$/.test(base)) return "video/x-matroska";
  if (/\.(mpeg|mpg|mpe|mpv|m1v|m2v)$/.test(base)) return "video/mpeg";
  if (/\.(m2ts|mts)$/.test(base)) return "video/mp2t";
  if (/\.webm$/.test(base)) return "video/webm";
  if (/\.(mp4|m4v)$/.test(base)) return "video/mp4";
  if (/\.(mov|qt)$/.test(base)) return "video/quicktime";
  if (/\.ogv$/.test(base)) return "video/ogg";
  if (/\.wmv$/.test(base)) return "video/x-ms-wmv";
  if (/\.(asf|wm)$/.test(base)) return "video/x-ms-asf";
  if (/\.ts$/.test(base)) return "video/mp2t";
  return undefined;
}

/** Derive a filename-like tail from a `file:` URL for MIME sniffing. */
export function mimeHintForLocalVideoUrl(url: string): string | undefined {
  const u = url.trim();
  if (!u) return undefined;
  try {
    if (/^file:/i.test(u)) {
      const path = decodeURIComponent(new URL(u).pathname);
      const seg = path.split(/[/\\]/).pop() ?? path;
      return mimeHintForLocalVideoFilename(seg);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
