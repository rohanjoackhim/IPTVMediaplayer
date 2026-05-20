/** HLS master or media playlist. */
export function isLikelyHls(url: string): boolean {
  return /\.m3u8($|\?)/i.test(url) || /application\/vnd\.apple\.mpegurl/i.test(url);
}

export function isLikelyProgressiveVideoUrl(url: string): boolean {
  return /\.(mp4|webm|og[gv]|m4v|mov)(\?|#|$)/i.test(url);
}

/** Matroska container (.mkv / .mka) — often needs FFmpeg remux to H.264/AAC for Chromium. */
export function isMatroskaUrl(url: string): boolean {
  try {
    const p = decodeURIComponent(new URL(url).pathname).replace(/\\/g, "/").toLowerCase();
    return /\.mkv($|[?#/])/i.test(p) || /\.mka($|[?#/])/i.test(p);
  } catch {
    return /\.mka?(\?|#|$|\/)/i.test(url);
  }
}

/** Xtream Codes VOD paths (`/movie/`, `/series/`) — often MKV/MP4 with a misleading `.ts` suffix or no extension. */
export function isLikelyXtreamVodPath(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isLikelyHls(url)) return false;
  try {
    const p = decodeURIComponent(new URL(url).pathname).replace(/\\/g, "/").toLowerCase();
    return /\/(movie|series)\//.test(p);
  } catch {
    return /\/(movie|series)\//i.test(url);
  }
}

/** Remote streams that should be remuxed/transcoded in the desktop app (Electron + FFmpeg). */
export function needsDesktopFfmpegPlayback(url: string): boolean {
  return isMatroskaUrl(url) || isLikelyXtreamVodPath(url);
}

/**
 * MPEG-TS over HTTP (Xtream Codes and similar). Browsers cannot play these natively;
 * use mpegts.js (MSE). Many panel URLs omit `.ts` or `/live/` — this list is intentionally broad.
 */
export function isLikelyMpegTsOverHttp(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isLikelyHls(url)) return false;
  if (isLikelyProgressiveVideoUrl(url)) return false;
  if (isMatroskaUrl(url)) return false;
  /** VOD links under /movie/ or /series/ are often mislabeled `.ts` but are not MPEG-TS. */
  if (isLikelyXtreamVodPath(url)) return false;

  const lower = url.toLowerCase();

  if (/\.ts(\?|#|$|&)/.test(lower)) return true;
  if (/\/live\//.test(lower)) return true;
  if (/\/play\//.test(lower)) return true;
  if (/mpegts|output=mpegts|type=mpegts/.test(lower)) return true;

  // Xtream-style play URL: .../get.php?...&stream=12345
  if (/\/get\.php\b/i.test(lower) && /[?&]stream=\d+/i.test(lower)) return true;

  return false;
}
