/**
 * When the app is served from localhost (Vite dev or Electron’s static server),
 * mpegts.js uses fetch() to the stream origin. Most IPTV hosts do not send
 * Access-Control-Allow-Origin, so the browser blocks the body (NetworkError).
 * Rewriting to this origin’s /__proxy/stream lets Node/Electron fetch upstream
 * without CORS on the renderer.
 */
export function shouldUseStreamProxy(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

/** True if URL is already our app’s CORS proxy or record tap (do not double-wrap). */
export function isAlreadyProxiedStreamUrl(url: string): boolean {
  try {
    const x = new URL(url);
    const h = x.hostname.toLowerCase();
    if (h !== "127.0.0.1" && h !== "localhost" && h !== "[::1]") return false;
    return x.pathname === "/__proxy/stream" || x.pathname === "/__tap/stream";
  } catch {
    return false;
  }
}

/**
 * @param proxyOrigin Optional base (e.g. second local static port in split view) so each pane gets its own browser connection pool.
 */
export function proxiedStreamUrl(originalUrl: string, proxyOrigin?: string): string {
  if (!shouldUseStreamProxy()) return originalUrl;
  const trimmed = originalUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return originalUrl;
  const origin =
    (proxyOrigin && proxyOrigin.trim()) ||
    (typeof window !== "undefined" ? window.location.origin : "");
  if (!origin) return originalUrl;
  const base = origin.replace(/\/$/, "");
  return `${base}/__proxy/stream?url=${encodeURIComponent(trimmed)}`;
}
