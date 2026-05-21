import type { Channel } from "../types";
import { fetchM3uPlaylist } from "./fetchM3uPlaylist";
import {
  extractProgrammesForChannelFromXml,
  parseXmltv,
  parseXmltvChannelIndex,
  MAX_RENDERER_XMLTV_BYTES,
  type EpgProgramme,
  type ParsedXmltv,
} from "./xmltvParser";

const CACHE_TTL_MS = 30 * 60 * 1000;

let cached: { url: string; fetchedAt: number; data: ParsedXmltv; rawText?: string } | null = null;
let inflight: { url: string; promise: Promise<{ data: ParsedXmltv; rawText: string }> } | null = null;

export function clearEpgCache(): void {
  cached = null;
  inflight = null;
}

export interface EpgLookupIndex {
  byIdLower: Map<string, string>;
  byNormName: Map<string, string>;
}

export function buildEpgLookupIndex(data: ParsedXmltv): EpgLookupIndex {
  const byIdLower = new Map<string, string>();
  const byNormName = new Map<string, string>();
  for (const [id, names] of data.channelNames) {
    byIdLower.set(id.toLowerCase(), id);
    const normId = normalizeEpgChannelName(id);
    if (normId) byNormName.set(normId, id);
    for (const dn of names) {
      const norm = normalizeEpgChannelName(dn);
      if (norm) byNormName.set(norm, id);
    }
  }
  return { byIdLower, byNormName };
}

export function mergeParsedXmltv(parts: ParsedXmltv[]): ParsedXmltv {
  const channelNames = new Map<string, string[]>();
  const programmes: EpgProgramme[] = [];
  for (const p of parts) {
    for (const [id, names] of p.channelNames) {
      channelNames.set(id, names);
    }
    programmes.push(...p.programmes);
  }
  programmes.sort((a, b) => a.start - b.start);
  return { channelNames, programmes };
}

async function fetchXmltvText(url: string, signal?: AbortSignal): Promise<string> {
  const text = await fetchM3uPlaylist(url);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return text;
}

export async function loadXmltvGuide(epgUrl: string, signal?: AbortSignal): Promise<ParsedXmltv> {
  const { data } = await loadXmltvGuideWithText(epgUrl, signal);
  return data;
}

export async function loadXmltvGuideWithText(
  epgUrl: string,
  signal?: AbortSignal
): Promise<{ data: ParsedXmltv; rawText: string }> {
  const url = epgUrl.trim();
  if (!url) throw new Error("EPG URL is empty.");

  if (cached && cached.url === url && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.rawText) {
    return { data: cached.data, rawText: cached.rawText };
  }

  if (inflight?.url === url) return inflight.promise;

  const promise = (async () => {
    const rawText = await fetchXmltvText(url, signal);
    const data =
      rawText.length > MAX_RENDERER_XMLTV_BYTES
        ? parseXmltvChannelIndex(rawText)
        : parseXmltv(rawText);
    cached = { url, fetchedAt: Date.now(), data, rawText };
    return { data, rawText };
  })();

  inflight = { url, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.url === url) inflight = null;
  }
}

/** Normalize channel titles for XMLTV display-name matching. */
export function normalizeEpgChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s*(hd|fhd|uhd|4k|sd|plus)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveEpgChannelId(channel: Channel, data: ParsedXmltv): string | null {
  return resolveEpgChannelIdWithIndex(channel, buildEpgLookupIndex(data));
}

/** Name / tvg-id variants for XMLTV matching (e.g. `CA.TSN 1` → `tsn 1`). */
export function epgMatchNameCandidates(channel: Channel): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const n = normalizeEpgChannelName(s);
    if (n && !out.includes(n)) out.push(n);
  };
  const name = channel.name?.trim() ?? "";
  if (name) {
    push(name);
    const prefix = /^[a-z]{2}\.(.+)$/i.exec(name);
    if (prefix) push(prefix[1]!);
  }
  const tvg = channel.tvgId?.trim();
  if (tvg) {
    push(tvg);
    push(tvg.replace(/\./g, " "));
    const parts = tvg.split(".").filter(Boolean);
    if (parts.length >= 2) push(parts.slice().reverse().join(" "));
  }
  return out;
}

function fuzzyResolveFromIndex(want: string, index: EpgLookupIndex): string | null {
  if (!want || want.length < 2) return null;
  const words = want.split(/\s+/).filter((w) => w.length > 1);
  let bestId: string | null = null;
  let bestScore = 0;
  for (const [norm, id] of index.byNormName) {
    let score = 0;
    if (norm === want) return id;
    if (norm.includes(want) || want.includes(norm)) score += 12;
    for (const w of words) {
      if (norm.includes(w)) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  const minScore = words.length >= 2 ? 8 : 6;
  return bestScore >= minScore ? bestId : null;
}

export function resolveEpgChannelIdWithIndex(channel: Channel, index: EpgLookupIndex): string | null {
  const tvg = channel.tvgId?.trim();
  if (tvg) {
    const hit = index.byIdLower.get(tvg.toLowerCase());
    if (hit) return hit;
    const tvgNorm = normalizeEpgChannelName(tvg);
    const fuzzyTvg = tvgNorm ? fuzzyResolveFromIndex(tvgNorm, index) : null;
    if (fuzzyTvg) return fuzzyTvg;
  }

  for (const want of epgMatchNameCandidates(channel)) {
    const hit = index.byNormName.get(want);
    if (hit) return hit;
    const fuzzy = fuzzyResolveFromIndex(want, index);
    if (fuzzy) return fuzzy;
  }

  return null;
}

export function programmesForChannel(data: ParsedXmltv, channelId: string): EpgProgramme[] {
  return data.programmes.filter((p) => p.channelId === channelId);
}

export function programmesInWindow(
  programmes: EpgProgramme[],
  fromMs: number,
  toMs: number
): EpgProgramme[] {
  return programmes.filter((p) => p.stop > fromMs && p.start < toMs);
}

export function currentProgramme(programmes: EpgProgramme[], nowMs = Date.now()): EpgProgramme | null {
  return programmes.find((p) => p.start <= nowMs && p.stop > nowMs) ?? null;
}

/** IANA time zone from the OS / browser (used for all EPG clock labels). */
export function epgSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

const epgClockFormatter = (() => {
  const tz = epgSystemTimeZone();
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return null;
  }
})();

/** Short note for EPG UI — times are rendered in the device time zone. */
export function epgSystemTimeZoneNote(): string {
  const tz = epgSystemTimeZone();
  return tz
    ? `Times shown in your system time zone (${tz}).`
    : "Times shown in your system time zone.";
}

export function formatEpgClock(ms: number): string {
  try {
    if (epgClockFormatter) return epgClockFormatter.format(new Date(ms));
  } catch {
    /* fall through */
  }
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatEpgTimeRange(startMs: number, stopMs: number): string {
  return `${formatEpgClock(startMs)} – ${formatEpgClock(stopMs)}`;
}

export async function loadProgrammesForEpgChannel(
  sourceUrl: string,
  epgChannelId: string,
  fromMs: number,
  toMs: number,
  signal?: AbortSignal
): Promise<EpgProgramme[]> {
  const { rawText } = await loadXmltvGuideWithText(sourceUrl, signal);
  if (rawText.length > MAX_RENDERER_XMLTV_BYTES) {
    return extractProgrammesForChannelFromXml(rawText, epgChannelId, fromMs, toMs);
  }
  const data = parseXmltv(rawText);
  return programmesInWindow(programmesForChannel(data, epgChannelId), fromMs, toMs);
}

export function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
