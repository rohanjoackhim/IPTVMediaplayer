/** LRCLIB + MyMemory GET (allow-listed in Electron). Google GTX + LibreTranslate use dedicated IPC or direct fetch. */
export type LyricsJsonFetcher = (url: string) => Promise<unknown>;

export function createLyricsJsonFetcher(): LyricsJsonFetcher {
  return async (url) => {
    const ipc = typeof window !== "undefined" ? window.iptv?.httpGetJson : undefined;
    if (typeof ipc === "function") {
      return ipc(url) as Promise<unknown>;
    }
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
      },
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
    return r.json() as Promise<unknown>;
  };
}
