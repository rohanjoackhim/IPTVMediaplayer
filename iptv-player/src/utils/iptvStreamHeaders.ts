/** Referer many IPTV / Xtream servers expect (same origin as the stream). */
export function streamRefererForUrl(streamUrl: string): string {
  try {
    const u = new URL(streamUrl);
    return `${u.origin}/`;
  } catch {
    return "";
  }
}

/** Extra mpegts.js config so segment requests look like a normal desktop browser. */
export function mpegtsIptvConfig(streamUrl: string): {
  headers?: Record<string, string>;
  referrerPolicy?: ReferrerPolicy;
  reuseRedirectedURL?: boolean;
} {
  const ref = streamRefererForUrl(streamUrl);
  if (!ref) return { reuseRedirectedURL: true };
  return {
    reuseRedirectedURL: true,
    referrerPolicy: "unsafe-url",
    headers: {
      Referer: ref,
      // Some panels sniff UA; Chromium may still restrict overriding UA in fetch.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    },
  };
}
