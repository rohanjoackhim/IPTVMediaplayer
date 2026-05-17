/** HLS master or media playlist. */
export function isLikelyHls(url: string): boolean {
  return /\.m3u8($|\?)/i.test(url) || /application\/vnd\.apple\.mpegurl/i.test(url);
}

export function isLikelyProgressiveVideoUrl(url: string): boolean {
  return /\.(mp4|webm|og[gv]|m4v|mov)(\?|#|$)/i.test(url);
}

/**
 * MPEG-TS over HTTP (Xtream Codes and similar). Browsers cannot play these natively;
 * use mpegts.js (MSE). Many panel URLs omit `.ts` or `/live/` — this list is intentionally broad.
 */
export function isLikelyMpegTsOverHttp(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isLikelyHls(url)) return false;
  if (isLikelyProgressiveVideoUrl(url)) return false;

  const lower = url.toLowerCase();

  if (/\.ts(\?|#|$|&)/.test(lower)) return true;
  if (/\/live\//.test(lower)) return true;
  if (/\/play\//.test(lower)) return true;
  if (/mpegts|output=mpegts|type=mpegts/.test(lower)) return true;

  // Xtream-style play URL: .../get.php?...&stream=12345
  if (/\/get\.php\b/i.test(lower) && /[?&]stream=\d+/i.test(lower)) return true;

  return false;
}
