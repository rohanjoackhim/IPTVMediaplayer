/** Free XMLTV guides (Open-EPG + global US-heavy guide). */
export const FREE_GLOBAL_EPG_URL = "https://epg.iptv.cat/epg.xml";

/** Regional Open-EPG files — https://www.open-epg.com/ (Unlicense). */
export const OPEN_EPG_BY_COUNTRY: Record<string, string> = {
  at: "https://www.open-epg.com/files/austria1.xml",
  be: "https://www.open-epg.com/files/belgium1.xml",
  bg: "https://www.open-epg.com/files/bulgaria1.xml",
  hr: "https://www.open-epg.com/files/croatia1.xml",
  cz: "https://www.open-epg.com/files/czech1.xml",
  dk: "https://www.open-epg.com/files/denmark1.xml",
  fi: "https://www.open-epg.com/files/finland1.xml",
  fr: "https://www.open-epg.com/files/france1.xml",
  de: "https://www.open-epg.com/files/germany1.xml",
  gr: "https://www.open-epg.com/files/greece1.xml",
  hu: "https://www.open-epg.com/files/hungary1.xml",
  nl: "https://www.open-epg.com/files/netherlands1.xml",
  no: "https://www.open-epg.com/files/norway1.xml",
  pl: "https://www.open-epg.com/files/poland1.xml",
  pt: "https://www.open-epg.com/files/portugal1.xml",
  ro: "https://www.open-epg.com/files/romania1.xml",
  rs: "https://www.open-epg.com/files/serbia1.xml",
  se: "https://www.open-epg.com/files/sweden1.xml",
  tr: "https://www.open-epg.com/files/turkey1.xml",
};

/** Keep low so the UI stays responsive (each guide is parsed off the main thread in chunks). */
const MAX_REGIONAL_GUIDES = 2;

/** Infer ISO country codes present in the playlist for regional EPG fetch. */
export function detectEpgCountriesFromChannels(
  channels: { country?: string; tvgId?: string; name?: string; group?: string }[]
): string[] {
  const counts = new Map<string, number>();
  const add = (code: string | null | undefined) => {
    const c = code?.trim().toLowerCase();
    if (!c || c.length !== 2) return;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  };

  for (const ch of channels) {
    add(ch.country);
    const tvg = ch.tvgId?.trim();
    if (tvg) {
      const dot = /\.([a-z]{2})$/i.exec(tvg);
      if (dot) add(dot[1]);
      const colon = /:([a-z]{2})$/i.exec(tvg);
      if (colon) add(colon[1]);
    }
    const name = ch.name ?? "";
    const prefix = /^([A-Za-z]{2})\.(.+)/.exec(name.trim());
    if (prefix) add(prefix[1].toLowerCase());
    const paren = /\(([A-Za-z]{2})\)\s*$/.exec(name);
    if (paren) add(paren[1].toLowerCase());
    const group = ch.group ?? "";
    const g = /\b([A-Za-z]{2})\b\s*[:|]/i.exec(group) || /\|\s*([A-Za-z]{2})\b/i.exec(group);
    if (g) add(g[1].toLowerCase());
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);

  const withOpenEpg = ranked.filter((code) => OPEN_EPG_BY_COUNTRY[code]);
  const out = withOpenEpg.slice(0, MAX_REGIONAL_GUIDES);
  const usHeavy = channels.some((ch) => /\.us$/i.test(ch.tvgId ?? "") || /\bus\b/i.test(ch.group ?? ""));
  if (usHeavy && !out.includes("us")) {
    /* US listings come from the global guide via Electron, not open-epg */
  }
  return out;
}

export function regionalEpgUrlsForCountries(codes: string[]): string[] {
  const urls = new Set<string>();
  for (const code of codes) {
    const url = OPEN_EPG_BY_COUNTRY[code];
    if (url) urls.add(url);
  }
  return [...urls];
}

export function channelLikelyUsesGlobalUsGuide(channel: {
  tvgId?: string;
  country?: string;
  name?: string;
}): boolean {
  if (/\.us$/i.test(channel.tvgId ?? "")) return true;
  const c = channel.country?.trim().toLowerCase();
  if (c === "us" || c === "usa") return true;
  if (/\b(usa|united states)\b/i.test(channel.name ?? "")) return true;
  return false;
}

/** Country codes for one channel (not limited to Open-EPG regions). */
export function inferEpgCountryCodesForChannel(channel: {
  country?: string;
  tvgId?: string;
  name?: string;
  group?: string;
}): string[] {
  return detectEpgCountriesFromChannels([channel]);
}

/**
 * XMLTV sources to try for a single channel: regional Open-EPG first, then global guide.
 * Without the global fallback, CA/US/UK channels often get zero URLs and Web EPG never runs.
 */
export function epgGuideUrlsForChannel(channel: {
  country?: string;
  tvgId?: string;
  name?: string;
  group?: string;
}): string[] {
  const urls: string[] = [];
  for (const code of inferEpgCountryCodesForChannel(channel)) {
    const regional = OPEN_EPG_BY_COUNTRY[code];
    if (regional && !urls.includes(regional)) urls.push(regional);
  }
  if (!urls.includes(FREE_GLOBAL_EPG_URL)) urls.push(FREE_GLOBAL_EPG_URL);
  return urls;
}
