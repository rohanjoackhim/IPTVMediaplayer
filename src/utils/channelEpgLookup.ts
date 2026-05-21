import type { Channel } from "../types";
import {
  buildEpgLookupIndex,
  formatEpgClock,
  loadProgrammesForEpgChannel,
  loadXmltvGuideWithText,
  resolveEpgChannelIdWithIndex,
} from "./epgService";
import { epgGuideUrlsForChannel, FREE_GLOBAL_EPG_URL } from "./freeEpgSources";
import { setChannelEpgCache } from "./channelEpgSession";
import { LLM_KEY_SETUP_HINT } from "./llmApiKeyGuide";
import type { EpgProgramme, ParsedXmltv } from "./xmltvParser";

export const EPG_NOT_AVAILABLE = "EPG not available";

const WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 8 * 60 * 60 * 1000;

export interface ChannelEpgLookupResult {
  ok: boolean;
  programmes: EpgProgramme[];
  source: string;
  message?: string;
  error?: string;
}

function stripJsonFences(raw: string): string {
  let t = raw.trim();
  const block = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(t);
  if (block) return block[1]!.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return t;
}

function todayMsFromLocalHm(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hm.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h > 23 || min > 59) return null;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  return d.getTime();
}

/** Parse LLM JSON `{ programmes: [{ title, start, stop, description? }] }`. */
export function parseLlmEpgProgrammes(raw: string, channelId: string): EpgProgramme[] {
  const trimmed = stripJsonFences(raw.trim());
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const list = (parsed as { programmes?: unknown }).programmes;
  if (!Array.isArray(list)) return [];
  const out: EpgProgramme[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const startRaw = typeof o.start === "string" ? o.start : "";
    const stopRaw = typeof o.stop === "string" ? o.stop : "";
    if (!title || !startRaw || !stopRaw) continue;
    const start = todayMsFromLocalHm(startRaw);
    let stop = todayMsFromLocalHm(stopRaw);
    if (start == null || stop == null) continue;
    if (stop <= start) stop += 24 * 60 * 60 * 1000;
    const description = typeof o.description === "string" ? o.description.trim() : undefined;
    out.push({ channelId, start, stop, title, description });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

async function loadEpgGuideIndex(url: string, signal?: AbortSignal): Promise<ParsedXmltv> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  if (url === FREE_GLOBAL_EPG_URL && window.iptv?.fetchEpgChannelIndex) {
    const res = await window.iptv.fetchEpgChannelIndex(url);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const names = res.channelNames ?? {};
    const channelNames = new Map<string, string[]>();
    for (const [id, list] of Object.entries(names)) {
      channelNames.set(id, Array.isArray(list) ? list : [id]);
    }
    return { channelNames, programmes: [] };
  }

  const { data } = await loadXmltvGuideWithText(url, signal);
  return data;
}

async function loadProgrammesForLookup(
  sourceUrl: string,
  epgChannelId: string,
  fromMs: number,
  toMs: number,
  signal?: AbortSignal
): Promise<EpgProgramme[]> {
  const extract = window.iptv?.extractEpgProgrammes;
  if (extract && sourceUrl === FREE_GLOBAL_EPG_URL) {
    const res = await extract({
      url: sourceUrl,
      channelId: epgChannelId,
      fromMs,
      toMs,
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return res.programmes ?? [];
  }

  return loadProgrammesForEpgChannel(sourceUrl, epgChannelId, fromMs, toMs, signal);
}

/** Fetch XMLTV guides (regional + global) and return listings for this channel only. */
export async function lookupChannelEpgOnline(
  channel: Channel,
  signal?: AbortSignal
): Promise<ChannelEpgLookupResult> {
  const now = Date.now();
  const from = now - WINDOW_BEFORE_MS;
  const to = now + WINDOW_AFTER_MS;
  const urls = epgGuideUrlsForChannel(channel);

  try {
    for (const url of urls) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const data = await loadEpgGuideIndex(url, signal);
      const index = buildEpgLookupIndex(data);
      const epgId = resolveEpgChannelIdWithIndex(channel, index);
      if (!epgId) continue;
      const programmes = await loadProgrammesForLookup(url, epgId, from, to, signal);
      if (programmes.length) {
        const sourceLabel =
          url === FREE_GLOBAL_EPG_URL ? "Online · IPTV.cat" : "Online · Open-EPG";
        const result: ChannelEpgLookupResult = {
          ok: true,
          programmes,
          source: sourceLabel,
          message: epgId,
        };
        setChannelEpgCache(channel.id, result);
        return result;
      }
    }
    return {
      ok: false,
      programmes: [],
      source: "Online",
      error: EPG_NOT_AVAILABLE,
    };
  } catch (e) {
    return {
      ok: false,
      programmes: [],
      source: "Online",
      error: e instanceof Error ? e.message : EPG_NOT_AVAILABLE,
    };
  }
}

export async function lookupChannelEpgLlm(
  channel: Channel,
  signal?: AbortSignal
): Promise<ChannelEpgLookupResult> {
  const llm = window.iptv?.channelEpgLlm;
  if (!llm) {
    return {
      ok: false,
      programmes: [],
      source: "LLM",
      error: EPG_NOT_AVAILABLE,
      message: LLM_KEY_SETUP_HINT,
    };
  }
  try {
    const res = await llm({
      name: channel.name,
      tvgId: channel.tvgId,
      country: channel.country,
      group: channel.group,
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!res.ok) {
      return {
        ok: false,
        programmes: [],
        source: "LLM",
        error: res.error?.trim() || EPG_NOT_AVAILABLE,
      };
    }
    const channelId = channel.tvgId?.trim() || channel.id;
    const programmes = parseLlmEpgProgrammes(res.rawJson ?? "", channelId);
    if (!programmes.length) {
      const hint = res.disclaimer?.trim() || "Could not parse schedule from LLM response.";
      return {
        ok: false,
        programmes: [],
        source: "LLM",
        error: EPG_NOT_AVAILABLE,
        message: hint,
      };
    }
    const result: ChannelEpgLookupResult = {
      ok: true,
      programmes,
      source: res.llmPurpose ? `LLM · ${res.llmPurpose}` : "LLM",
      message: res.disclaimer?.trim() || "Approximate schedule.",
    };
    setChannelEpgCache(channel.id, result);
    return result;
  } catch (e) {
    return {
      ok: false,
      programmes: [],
      source: "LLM",
      error: e instanceof Error ? e.message : EPG_NOT_AVAILABLE,
    };
  }
}

/** Try online XMLTV first, then LLM. */
export async function lookupChannelEpg(
  channel: Channel,
  signal?: AbortSignal
): Promise<ChannelEpgLookupResult> {
  const online = await lookupChannelEpgOnline(channel, signal);
  if (online.ok && online.programmes.length) return online;
  const llm = await lookupChannelEpgLlm(channel, signal);
  if (llm.ok && llm.programmes.length) return llm;
  return {
    ok: false,
    programmes: [],
    source: "",
    error: llm.error || online.error || EPG_NOT_AVAILABLE,
    message: llm.message || online.message,
  };
}

export function formatEpgLookupSummary(programmes: EpgProgramme[]): string {
  if (!programmes.length) return "";
  const now = Date.now();
  const current = programmes.find((p) => p.start <= now && p.stop > now);
  if (current)
    return `Now: ${current.title} (${formatEpgClock(current.start)} – ${formatEpgClock(current.stop)})`;
  const next = programmes.find((p) => p.start > now);
  if (next) return `Next: ${next.title} at ${formatEpgClock(next.start)}`;
  return `${programmes.length} listings`;
}
