export interface LlmUnifiedLyricsCoerced {
  pairs: { orig: string; en: string }[];
  headline: string;
  detectedFranc3: string;
  lrclibTrack?: string;
  llmPurpose?: string;
  llmModel?: string;
  llmHost?: string;
}

/** Normalizes main-process `iptv-lyrics-llm-unified-fetch` payload → result, or null if unusable. */
export function coerceLlmUnifiedIpcResult(raw: unknown): LlmUnifiedLyricsCoerced | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) return null;
  const pairsIn = o.pairs;
  if (!Array.isArray(pairsIn) || pairsIn.length === 0) return null;
  const pairs: { orig: string; en: string }[] = [];
  for (const row of pairsIn) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const orig = typeof r.orig === "string" ? r.orig.replace(/\r\n/g, "\n").trimEnd() : "";
    let en = typeof r.en === "string" ? r.en.replace(/\r\n/g, "\n").trimEnd() : "";
    if (!orig) continue;
    if (!en) en = orig;
    pairs.push({ orig, en });
  }
  if (!pairs.length) return null;
  let detectedFranc3 = typeof o.detectedFranc3 === "string" ? o.detectedFranc3.trim().toLowerCase() : "und";
  if (!/^[a-z]{3}$/.test(detectedFranc3)) detectedFranc3 = "und";
  const headline =
    typeof o.headline === "string" && o.headline.trim()
      ? o.headline.trim()
      : "LLM · find + translate in one step (verify)";
  const llmModel = typeof o.llmModel === "string" ? o.llmModel.trim().slice(0, 80) : "";
  const llmHost = typeof o.llmHost === "string" ? o.llmHost.trim().slice(0, 120) : "";
  let headlineOut = headline;
  if (llmModel && llmHost) {
    headlineOut += ` · ${llmModel} @ ${llmHost}`;
  } else if (llmModel) {
    headlineOut += ` · model: ${llmModel}`;
  } else if (llmHost) {
    headlineOut += ` · host: ${llmHost}`;
  }
  const lrclibTrack =
    typeof o.lrclibTrack === "string" && o.lrclibTrack.trim() ? o.lrclibTrack.trim() : undefined;
  const llmPurpose =
    typeof o.llmPurpose === "string" && o.llmPurpose.trim() ? o.llmPurpose.trim() : "lyrics find + translate";
  return {
    pairs,
    headline: headlineOut,
    detectedFranc3,
    lrclibTrack,
    llmPurpose,
    llmModel: llmModel || undefined,
    llmHost: llmHost || undefined,
  };
}

/**
 * Desktop: one LLM call to find lyrics + English lines (same API key as Lyrics translation — LLM).
 * Returns null if IPC missing, no key, or model declines / returns empty (caller should fall back to LRCLIB).
 */
export async function tryUnifiedLlmLyrics(
  displayName: string,
  durationSec: number | null,
  fileMeta: { artist: string; title: string; album?: string } | null,
  signal?: AbortSignal
): Promise<LlmUnifiedLyricsCoerced | null> {
  const ipc = typeof window !== "undefined" ? window.iptv?.lyricsLlmUnifiedFetch : undefined;
  if (typeof ipc !== "function") return null;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let raw: unknown;
  try {
    raw = await ipc({
      displayName,
      durationSec,
      metaArtist: fileMeta?.artist?.trim() || undefined,
      metaTitle: fileMeta?.title?.trim() || undefined,
      metaAlbum: fileMeta?.album?.trim() || undefined,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) return null;
    throw e;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.ok === false) {
      const err =
        typeof o.error === "string" && o.error.trim()
          ? o.error.trim()
          : "LLM could not find lyrics for this track.";
      throw new Error(err);
    }
  }
  return coerceLlmUnifiedIpcResult(raw);
}
