/** HLS master or media playlist. */
export function isLikelyHls(url: string): boolean {
  return /\.m3u8($|\?)/i.test(url) || /application\/vnd\.apple\.mpegurl/i.test(url);
}

function isLikelyProgressiveContainer(url: string): boolean {
  return /\.(mp4|webm|og[gv]|m4v|mov)(\?|#|$)/i.test(url);
}

/**
 * MPEG-TS over HTTP (Xtream Codes and similar). Browsers cannot play these natively;
 * use mpegts.js (MSE). Many panel URLs omit `.ts` or `/live/` — this list is intentionally broad.
 */
export function isLikelyMpegTsOverHttp(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (isLikelyHls(url)) return false;
  if (isLikelyProgressiveContainer(url)) return false;

  const lower = url.toLowerCase();

  if (/\.ts(\?|#|$|&)/.test(lower)) return true;
  if (/\/live\//.test(lower)) return true;
  if (/\/movie\//.test(lower)) return true;
  if (/\/series\//.test(lower)) return true;
  if (/\/play\//.test(lower)) return true;
  if (/\/stream\//.test(lower)) return true;
  if (/\/streams\//.test(lower)) return true;
  if (/mpegts|output=mpegts|type=mpegts/.test(lower)) return true;

  // Xtream-style play URL: .../get.php?...&stream=12345
  if (/\/get\.php\b/i.test(lower) && /[?&]stream=\d+/i.test(lower)) return true;

  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    const lastSeg = last.split("?")[0] ?? "";
    if (/^\d+$/.test(lastSeg)) return true;
  } catch {
    /* ignore */
  }

  return false;
}
