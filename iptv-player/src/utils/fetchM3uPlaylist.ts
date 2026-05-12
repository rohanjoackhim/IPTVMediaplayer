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

/**
 * Fetches M3U/M3U8 text. Tries the browser first; in dev, falls back to the Vite
 * same-origin proxy when the remote server blocks CORS.
 */
export async function fetchM3uPlaylist(urlString: string): Promise<string> {
  const u = assertHttpPlaylistUrl(urlString);

  const readResponse = async (res: Response): Promise<string> => {
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      throw new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
    }
    return res.text();
  };

  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      signal: AbortSignal.timeout(120_000),
    });
    return await readResponse(res);
  } catch (first) {
    if (!import.meta.env.DEV) {
      throw first instanceof Error
        ? first
        : new Error("Could not load playlist (network or CORS). Try dev server (npm run dev) or download the file.");
    }
    const proxyUrl = `${PROXY_PATH}?target=${encodeURIComponent(u.toString())}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(120_000) });
    return await readResponse(res);
  }
}
