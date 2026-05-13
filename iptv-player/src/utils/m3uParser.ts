import type { Channel, ParseResult } from "../types";
import { inferCountryFromGroupTitle, normalizeCountryLabel } from "./countryFromM3u";

let idCounter = 0;
function nextId(): string {
  return `ch-${++idCounter}`;
}

/**
 * Parses extended M3U (IPTV) playlists: #EXTINF + URL lines.
 */
export function parseM3U(text: string): ParseResult {
  const errors: string[] = [];
  const channels: Channel[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

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
      channels.push({
        id: nextId(),
        name: pending.name ?? "Unnamed channel",
        url,
        logo: pending.logo,
        group: pending.group,
        country: pending.country,
      });
      pending = null;
    } else if (/^https?:\/\//i.test(url) || url.startsWith("rtmp://") || url.startsWith("rtsp://")) {
      channels.push({
        id: nextId(),
        name: `Stream ${channels.length + 1}`,
        url,
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

  return {
    name: name || undefined,
    logo: attrs["tvg-logo"] || attrs["logo"],
    group,
    country: countryFromAttrs(attrs),
  };
}
