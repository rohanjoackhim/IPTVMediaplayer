const PROXY_PATH = "/__proxy/m3u";

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "169.254.169.254") return true;
  if (h === "metadata.google.internal" || h.endsWith(".metadata.google.internal")) return true;
  return false;
}

/** Validates user-supplied URL before fetch or proxy. */
export function assertHttpPlaylistUrl(urlString: string): URL {
  let u: URL;
  try {
    u = new URL(urlString.trim());
  } catch {
    throw new Error("Invalid playlist URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) playlist links are supported.");
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error("That host is not allowed.");
  }
  return u;
}

function abortAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const readResponse = async (res: Response): Promise<string> => {
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
  }
  return res.text();
};

/**
 * Fetches M3U/M3U8 text.
 * - **Electron (.exe)**: main process fetch (no CORS).
 * - **Browser + `npm run dev`**: direct fetch, then Vite `/__proxy/m3u` on failure.
 * - **Static / preview build**: direct fetch only (will fail if the playlist host blocks CORS).
 */
export async function fetchM3uPlaylist(urlString: string): Promise<string> {
  const u = assertHttpPlaylistUrl(urlString);
  const url = u.toString();

  if (typeof window !== "undefined" && window.iptv?.fetchPlaylistText) {
    return window.iptv.fetchPlaylistText(url);
  }

  const tryDirect = async () => {
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      signal: abortAfter(120_000),
    });
    return readResponse(res);
  };

  const tryDevProxy = async () => {
    const proxyPath = `${PROXY_PATH}?target=${encodeURIComponent(url)}`;
    const proxyUrl =
      typeof window !== "undefined" && window.location?.origin
        ? new URL(proxyPath, window.location.origin).toString()
        : proxyPath;
    const res = await fetch(proxyUrl, { signal: abortAfter(120_000) });
    return readResponse(res);
  };

  try {
    return await tryDirect();
  } catch (first) {
    if (import.meta.env.DEV) {
      try {
        return await tryDevProxy();
      } catch (second) {
        const a = first instanceof Error ? first.message : String(first);
        const b = second instanceof Error ? second.message : String(second);
        throw new Error(`Could not load playlist. Browser: ${a}. Dev proxy: ${b}.`);
      }
    }
    throw first instanceof Error
      ? first
      : new Error(
          "Could not load playlist (network or CORS). Use the desktop app, run npm run dev for the playlist proxy, or load an .m3u file from disk."
        );
  }
}
