/**
 * Apple iTunes Search API — free podcast directory (no API key).
 * https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/
 */
import type { Channel } from "../types";

const API_BASE = "https://itunes.apple.com";

export interface PodcastCountryRow {
  code: string;
  name: string;
}

export interface PodcastGenreRow {
  id: number;
  name: string;
}

export interface PodcastShowRow {
  collectionId: number;
  collectionName: string;
  artistName: string;
  artworkUrl?: string;
  feedUrl?: string;
  primaryGenreName?: string;
  trackCount?: number;
  country?: string;
}

export interface PodcastEpisodeRow {
  trackId: number;
  trackName: string;
  collectionId: number;
  collectionName: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  episodeUrl?: string;
  previewUrl?: string;
  artworkUrl?: string;
  description?: string;
}

/** Common storefronts for podcast discovery (iTunes country codes). */
export const PODCAST_COUNTRIES: PodcastCountryRow[] = [
  { code: "us", name: "United States" },
  { code: "gb", name: "United Kingdom" },
  { code: "ca", name: "Canada" },
  { code: "au", name: "Australia" },
  { code: "de", name: "Germany" },
  { code: "fr", name: "France" },
  { code: "es", name: "Spain" },
  { code: "it", name: "Italy" },
  { code: "nl", name: "Netherlands" },
  { code: "se", name: "Sweden" },
  { code: "no", name: "Norway" },
  { code: "dk", name: "Denmark" },
  { code: "fi", name: "Finland" },
  { code: "ie", name: "Ireland" },
  { code: "nz", name: "New Zealand" },
  { code: "in", name: "India" },
  { code: "jp", name: "Japan" },
  { code: "br", name: "Brazil" },
  { code: "mx", name: "Mexico" },
  { code: "za", name: "South Africa" },
];

/** Apple Podcasts genre IDs (subset of common categories). */
export const PODCAST_GENRES: PodcastGenreRow[] = [
  { id: 0, name: "All genres" },
  { id: 1311, name: "News" },
  { id: 1310, name: "Music" },
  { id: 1303, name: "Comedy" },
  { id: 1304, name: "Education" },
  { id: 1483, name: "Fiction" },
  { id: 1307, name: "Health & Fitness" },
  { id: 1487, name: "History" },
  { id: 1305, name: "Kids & Family" },
  { id: 1321, name: "Business" },
  { id: 1315, name: "Science" },
  { id: 1316, name: "Sports" },
  { id: 1324, name: "Society & Culture" },
  { id: 1318, name: "Technology" },
  { id: 1309, name: "TV & Film" },
  { id: 1314, name: "Religion & Spirituality" },
  { id: 1301, name: "Arts" },
  { id: 1489, name: "True Crime" },
];

interface ItunesSearchResponse<T> {
  resultCount: number;
  results: T[];
}

async function itunesFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t ? `iTunes HTTP ${res.status}: ${t.slice(0, 120)}` : `iTunes HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function normalizeShow(raw: Record<string, unknown>): PodcastShowRow | null {
  const collectionId = Number(raw.collectionId);
  const collectionName = typeof raw.collectionName === "string" ? raw.collectionName.trim() : "";
  if (!Number.isFinite(collectionId) || collectionId <= 0 || !collectionName) return null;
  const artistName = typeof raw.artistName === "string" ? raw.artistName.trim() : "Podcast";
  const artworkUrl =
    typeof raw.artworkUrl600 === "string"
      ? raw.artworkUrl600
      : typeof raw.artworkUrl100 === "string"
        ? raw.artworkUrl100
        : undefined;
  return {
    collectionId,
    collectionName,
    artistName,
    artworkUrl,
    feedUrl: typeof raw.feedUrl === "string" ? raw.feedUrl : undefined,
    primaryGenreName: typeof raw.primaryGenreName === "string" ? raw.primaryGenreName : undefined,
    trackCount: typeof raw.trackCount === "number" ? raw.trackCount : undefined,
    country: typeof raw.country === "string" ? raw.country : undefined,
  };
}

function normalizeEpisode(raw: Record<string, unknown>): PodcastEpisodeRow | null {
  const trackId = Number(raw.trackId);
  const trackName = typeof raw.trackName === "string" ? raw.trackName.trim() : "";
  const collectionId = Number(raw.collectionId);
  const collectionName = typeof raw.collectionName === "string" ? raw.collectionName.trim() : "Podcast";
  const episodeUrl = typeof raw.episodeUrl === "string" ? raw.episodeUrl.trim() : "";
  const previewUrl = typeof raw.previewUrl === "string" ? raw.previewUrl.trim() : "";
  const url = episodeUrl || previewUrl;
  if (!Number.isFinite(trackId) || trackId <= 0 || !trackName || !url) return null;
  const artworkUrl =
    typeof raw.artworkUrl600 === "string"
      ? raw.artworkUrl600
      : typeof raw.artworkUrl100 === "string"
        ? raw.artworkUrl100
        : undefined;
  return {
    trackId,
    trackName,
    collectionId: Number.isFinite(collectionId) ? collectionId : 0,
    collectionName,
    releaseDate: typeof raw.releaseDate === "string" ? raw.releaseDate : undefined,
    trackTimeMillis: typeof raw.trackTimeMillis === "number" ? raw.trackTimeMillis : undefined,
    episodeUrl: episodeUrl || undefined,
    previewUrl: previewUrl || undefined,
    artworkUrl,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

/** Search free podcasts in a storefront, optionally filtered by genre. */
export async function fetchPodcastShows(
  opts: { countryCode: string; genreId?: number; term?: string; limit?: number },
  signal?: AbortSignal
): Promise<PodcastShowRow[]> {
  const country = opts.countryCode.trim().toLowerCase() || "us";
  const limit = Math.min(200, Math.max(1, opts.limit ?? 200));
  const term = (opts.term?.trim() || "podcast").slice(0, 80);
  const params = new URLSearchParams({
    term,
    media: "podcast",
    entity: "podcast",
    limit: String(limit),
    country,
  });
  if (opts.genreId && opts.genreId > 0) params.set("genreId", String(opts.genreId));
  const data = await itunesFetch<ItunesSearchResponse<Record<string, unknown>>>(
    `/search?${params.toString()}`,
    signal
  );
  if (!Array.isArray(data.results)) return [];
  const seen = new Set<number>();
  const out: PodcastShowRow[] = [];
  for (const row of data.results) {
    const show = normalizeShow(row);
    if (!show || seen.has(show.collectionId)) continue;
    seen.add(show.collectionId);
    out.push(show);
  }
  return out;
}

/** Recent episodes for a show (direct enclosure URLs when available). */
export async function fetchPodcastEpisodes(
  collectionId: number,
  opts: { countryCode?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<PodcastEpisodeRow[]> {
  const id = Math.floor(collectionId);
  if (id <= 0) return [];
  const country = opts.countryCode?.trim().toLowerCase() || "us";
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const params = new URLSearchParams({
    id: String(id),
    media: "podcast",
    entity: "podcastEpisode",
    limit: String(limit),
    sort: "recent",
    country,
  });
  const data = await itunesFetch<ItunesSearchResponse<Record<string, unknown>>>(
    `/lookup?${params.toString()}`,
    signal
  );
  if (!Array.isArray(data.results)) return [];
  const out: PodcastEpisodeRow[] = [];
  for (const row of data.results) {
    const ep = normalizeEpisode(row);
    if (ep) out.push(ep);
  }
  return out;
}

export function podcastEpisodeToChannel(ep: PodcastEpisodeRow, show?: PodcastShowRow): Channel {
  const url = (ep.episodeUrl || ep.previewUrl || "").trim();
  const showName = show?.collectionName || ep.collectionName;
  return {
    id: `podcast-${ep.collectionId || show?.collectionId || 0}-${ep.trackId}`,
    name: ep.trackName.trim() || "Episode",
    url,
    logo: ep.artworkUrl || show?.artworkUrl,
    group: showName.trim() || "Podcast",
    country: show?.country,
    podcastShowName: showName.trim() || "Podcast",
    podcastAuthor: show?.artistName,
    podcastGenre: show?.primaryGenreName,
    podcastReleaseDate: ep.releaseDate,
    podcastDurationMs: ep.trackTimeMillis,
    podcastDescription: ep.description,
  };
}

export function formatPodcastDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatPodcastDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
