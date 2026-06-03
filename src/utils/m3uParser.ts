import type { Channel, ChannelContentType, ParseResult } from "../types";
import { inferCountryFromGroupTitle, normalizeCountryLabel } from "./countryFromM3u";

let idCounter = 0;
function nextId(): string {
  return `ch-${++idCounter}`;
}

/**
 * Parses extended M3U (IPTV) playlists: #EXTINF + URL lines.
 */
/** Strip UTF-8/UTF-16 BOM and leading whitespace before parsing. */
export function normalizeM3uText(text: string): string {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.trim();
}

/** Infer content type from a stream URL path (Xtream-style). */
function inferContentTypeFromUrl(url: string): ChannelContentType | undefined {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (/\/movie\//.test(p)) return "movie";
    if (/\/series\//.test(p)) return "series";
    if (/\/live\//.test(p)) return "live";
  } catch { /* invalid URL */ }
  return undefined;
}

export function parseM3U(text: string): ParseResult {
  const errors: string[] = [];
  const channels: Channel[] = [];
  const lines = normalizeM3uText(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let pending: Partial<Channel> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#EXTM3U")) continue;

    if (line.startsWith("#EXTINF:")) {
      pending = parseExtInf(line);
      continue;
    }

    if (line.startsWith("#")) continue;

    const url = line;
    if (pending) {
      const ch: Channel = {
        id: nextId(),
        name: pending.name ?? "Unnamed channel",
        url,
        logo: pending.logo,
        group: pending.group,
        country: pending.country,
        tvgId: pending.tvgId,
        contentType: pending.contentType ?? inferContentTypeFromUrl(url),
        seriesName: pending.seriesName,
        seriesSeason: pending.seriesSeason,
        seriesEpisode: pending.seriesEpisode,
        episodeTitle: pending.episodeTitle,
        seriesId: pending.seriesId,
        releaseYear: pending.releaseYear,
        rating: pending.rating,
        plot: pending.plot,
        genre: pending.genre,
        containerExtension: pending.containerExtension,
      };
      channels.push(ch);
      pending = null;
    } else if (/^https?:\/\//i.test(url) || url.startsWith("rtmp://") || url.startsWith("rtsp://")) {
      channels.push({
        id: nextId(),
        name: `Stream ${channels.length + 1}`,
        url,
        contentType: inferContentTypeFromUrl(url),
      });
    }
  }

  if (channels.length === 0) {
    errors.push("No playable entries found. Expected #EXTINF lines with URLs or raw stream URLs.");
  }

  return { channels, errors };
}

function countryFromAttrs(attrs: Record<string, string>): string | undefined {
  const raw =
    attrs["tvg-country"] ||
    attrs["country"] ||
    attrs["tvg-country-code"] ||
    attrs["tvg-countryname"] ||
    "";
  const fromAttr = raw.trim() ? normalizeCountryLabel(raw) : "";
  const group = attrs["group-title"] || attrs["group"];
  const fromGroup = inferCountryFromGroupTitle(group);
  const out = fromAttr || fromGroup;
  return out || undefined;
}

function parseContentType(attrs: Record<string, string>): ChannelContentType | undefined {
  const ct = (attrs["content-type"] || "").trim().toLowerCase();
  if (ct === "live" || ct === "movie" || ct === "series") return ct;
  return undefined;
}

function parseIntAttr(attrs: Record<string, string>, key: string): number | undefined {
  const v = attrs[key];
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseExtInf(line: string): Partial<Channel> {
  // #EXTINF:-1 tvg-id="x" tvg-logo="..." group-title="News",Channel Name
  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+(?:-\w+)*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(line)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }

  const commaIdx = line.lastIndexOf(",");
  const name =
    commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : line.replace(/^#EXTINF:[^,]*,?\s*/, "").trim();

  const group = attrs["group-title"] || attrs["group"];

  const tvgId = attrs["tvg-id"] || attrs["tvg_id"] || attrs["tvgid"];

  return {
    name: name || undefined,
    logo: attrs["tvg-logo"] || attrs["logo"],
    group,
    country: countryFromAttrs(attrs),
    tvgId: tvgId?.trim() || undefined,
    contentType: parseContentType(attrs),
    seriesName: attrs["series-name"]?.trim() || undefined,
    seriesSeason: parseIntAttr(attrs, "series-season"),
    seriesEpisode: parseIntAttr(attrs, "series-episode"),
    episodeTitle: attrs["episode-title"]?.trim() || undefined,
    seriesId: parseIntAttr(attrs, "series-id"),
    releaseYear: attrs["release-year"]?.trim() || undefined,
    rating: attrs["rating"]?.trim() || undefined,
    plot: attrs["plot"]?.trim() || attrs["tvg-description"]?.trim() || undefined,
    genre: attrs["genre"]?.trim() || undefined,
    containerExtension: attrs["container-ext"]?.trim() || undefined,
  };
}
