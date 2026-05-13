/**
 * Radio Browser (https://www.radio-browser.info/) — open directory of stream URLs.
 * Requires a descriptive User-Agent per project policy.
 */
import type { Channel } from "../types";

const API_BASE = "https://all.api.radio-browser.info";
const USER_AGENT =
  "RJ-IPTV-and-Online-Radio-Player/1.0 (https://github.com; radio-browser.info client)";

export interface RadioBrowserCountryRow {
  name: string;
  stationcount: number;
  iso_3166_1?: string;
}

export interface RadioBrowserStationRow {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  codec?: string;
  bitrate?: number;
}

async function rbFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t ? `Radio Browser HTTP ${res.status}: ${t.slice(0, 120)}` : `Radio Browser HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Countries with at least one non-broken station, sorted A–Z by name. */
export async function fetchRadioCountries(signal?: AbortSignal): Promise<RadioBrowserCountryRow[]> {
  const rows = await rbFetch<RadioBrowserCountryRow[]>(
    "/json/countries?hidebroken=true&order=stationcount&reverse=true",
    signal
  );
  const filtered = rows.filter((r) => typeof r.name === "string" && r.name.trim() && (r.stationcount ?? 0) > 0);
  return filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Up to 500 stations for a country name (as returned by /json/countries). */
export async function fetchRadioStationsByCountry(
  countryName: string,
  signal?: AbortSignal
): Promise<RadioBrowserStationRow[]> {
  const enc = encodeURIComponent(countryName.trim());
  let rows = await rbFetch<RadioBrowserStationRow[]>(
    `/json/stations/bycountryexact/${enc}?hidebroken=true&order=votes&reverse=true&limit=500`,
    signal
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    rows = await rbFetch<RadioBrowserStationRow[]>(
      `/json/stations/search?country=${enc}&limit=500&hidebroken=true&order=votes&reverse=true`,
      signal
    );
  }
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => typeof r.stationuuid === "string" && (r.url_resolved || r.url)?.trim());
}

export function radioStationToChannel(s: RadioBrowserStationRow): Channel {
  const url = (s.url_resolved || s.url || "").trim();
  const fav = s.favicon?.trim();
  return {
    id: `radio-${s.stationuuid}`,
    name: (s.name || "Station").trim() || "Station",
    url,
    logo: fav && /^https?:\/\//i.test(fav) ? fav : undefined,
    group: "Internet radio",
    country: s.country?.trim() || s.countrycode?.trim() || undefined,
  };
}
