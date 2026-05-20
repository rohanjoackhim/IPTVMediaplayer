import type { LibraryLyricsCacheRow } from "./audioLibraryDb";
import { getAudioLibraryTrackById, getLibraryLyricsCache, putLibraryLyricsCache } from "./audioLibraryDb";
import { fetchLyricsLlmEndpointInfo, hasLyricsLlmKey, hasSongMeaningKey } from "./lyricsLlmEndpointLabel";
import { createLyricsJsonFetcher } from "./lyricsJsonFetch";
import { lyricsMetadataDiffers, tokenSimilarityForLyrics } from "./lyricsTrackIdentity";
import { tryUnifiedLlmLyrics, type LlmUnifiedLyricsCoerced } from "./llmUnifiedLyricsIpc";
import { fetchSongMeaningFromLlm } from "./llmSongMeaningIpc";
import type { LyricsFileMetadata } from "./lyricsQueryVariants";
import { lrclibFindBestLyrics } from "./lrclibSearchLyrics";
import {
  lrclibLabelFromMetadata,
  resolveTrackMetadataFromLibrary,
  type TrackFileMetadata,
} from "./resolveTrackMetadata";
import { myMemorySourceForFranc3 } from "./franc3ToMyMemorySource";
import { translateLineBatchesToEnglish } from "./translateLyricsLines";

export interface LyricLinePair {
  orig: string;
  en: string;
}

export interface LocalMp3LyricsResult {
  pairs: LyricLinePair[];
  headline: string;
  detectedFranc3: string;
  lrclibTrack?: string;
  songMeaning?: string;
  songMeaningError?: string;
  lyricsLlmPurpose?: string;
  lyricsLlmModel?: string;
  lyricsLlmHost?: string;
  songMeaningLlmPurpose?: string;
  songMeaningLlmModel?: string;
  songMeaningLlmHost?: string;
  metaArtist?: string;
  metaTitle?: string;
  manualSaved?: boolean;
  fromLocalCache?: boolean;
}

/** Bump when lyrics matching logic changes so stale IndexedDB lyrics are refetched. */
export const LOCAL_LYRICS_MATCH_VERSION = 5;

function buildLrclibSearchMetas(
  fileMeta: TrackFileMetadata,
  altMeta: TrackFileMetadata
): LyricsFileMetadata[] {
  const primary = toLyricsFileMetadata(fileMeta);
  const metas: LyricsFileMetadata[] = [primary];
  const alt = toLyricsFileMetadata(altMeta);
  if (lyricsMetadataDiffers(fileMeta, altMeta)) {
    metas.push(alt);
    if (primary.title?.trim() && alt.artist?.trim()) {
      metas.push({ artist: alt.artist, title: primary.title, album: primary.album });
    }
    if (primary.artist?.trim() && alt.title?.trim()) {
      metas.push({ artist: primary.artist, title: alt.title, album: primary.album });
    }
  }
  return metas;
}

function applyLyricsLlmMeta(
  result: LocalMp3LyricsResult,
  purpose: string,
  model?: string,
  host?: string
): LocalMp3LyricsResult {
  if (!model || !host) return result;
  return {
    ...result,
    lyricsLlmPurpose: purpose,
    lyricsLlmModel: model,
    lyricsLlmHost: host,
  };
}

function splitLyricLines(plain: string): string[] {
  return plain
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);
}

function toLyricsFileMetadata(meta: TrackFileMetadata): LyricsFileMetadata {
  return {
    artist: meta.artist,
    title: meta.title,
    album: meta.album || undefined,
  };
}

async function librarySourceFileName(trackId: string): Promise<string> {
  const tid = trackId.trim();
  if (!tid) return "";
  try {
    const row = await getAudioLibraryTrackById(tid);
    return row?.sourceFileName?.trim() || row?.name?.trim() || "";
  } catch {
    return "";
  }
}

async function buildLlmLyricsFetchHints(
  displayName: string,
  fileMeta: TrackFileMetadata,
  trackId: string
): Promise<{
  sourceFileName?: string;
  altArtist?: string;
  altTitle?: string;
  playerHeaderLabel?: string;
}> {
  const sourceFileName = await librarySourceFileName(trackId);
  const altMeta = await resolveTrackMetadataFromLibrary(displayName, trackId, { preferFilename: true });
  const altLyrics = toLyricsFileMetadata(altMeta);
  return {
    sourceFileName: sourceFileName || undefined,
    altArtist: altLyrics.artist || undefined,
    altTitle: altLyrics.title || undefined,
    playerHeaderLabel: lrclibLabelFromMetadata(fileMeta, displayName) || undefined,
  };
}

/** LLM lyrics with filename hints; retries with filename-only metadata when tags disagree. */
async function tryUnifiedLlmLyricsWithRetries(
  displayName: string,
  durationSec: number | null,
  fileMeta: TrackFileMetadata,
  lyricsMeta: LyricsFileMetadata,
  signal: AbortSignal | undefined,
  trackId: string
): Promise<LlmUnifiedLyricsCoerced | null> {
  const hints = await buildLlmLyricsFetchHints(displayName, fileMeta, trackId);

  let unified = await tryUnifiedLlmLyrics(displayName, durationSec, lyricsMeta, signal, hints);
  if (unified?.pairs.length) return unified;

  const altMeta = await resolveTrackMetadataFromLibrary(displayName, trackId, { preferFilename: true });
  const altLyrics = toLyricsFileMetadata(altMeta);
  if (lyricsMetadataDiffers(fileMeta, altMeta)) {
    unified = await tryUnifiedLlmLyrics(displayName, durationSec, altLyrics, signal, {
      sourceFileName: hints.sourceFileName,
      playerHeaderLabel: lrclibLabelFromMetadata(altMeta, displayName) || hints.playerHeaderLabel,
    });
    if (unified?.pairs.length) return unified;
  }
  return null;
}

/** Map IndexedDB lyrics row → UI result (caller should load cache before fetch). */
export function mapCachedLibraryLyricsToResult(cached: LibraryLyricsCacheRow): LocalMp3LyricsResult {
  const a = cached.metaArtist?.trim() ?? "";
  const t = cached.metaTitle?.trim() ?? "";
  const headline = a && t ? `${a} — ${t}` : "Lyrics";
  return {
    pairs: cached.pairs,
    headline,
    detectedFranc3: cached.detectedFranc3,
    lrclibTrack: cached.lrclibTrack,
    songMeaning: cached.songMeaning?.trim() || undefined,
    songMeaningError: undefined,
    lyricsLlmPurpose: cached.lyricsLlmPurpose?.trim() || undefined,
    lyricsLlmModel: cached.lyricsLlmModel?.trim() || undefined,
    lyricsLlmHost: cached.lyricsLlmHost?.trim() || undefined,
    songMeaningLlmPurpose: cached.songMeaningLlmPurpose?.trim() || undefined,
    songMeaningLlmModel: cached.songMeaningLlmModel?.trim() || undefined,
    songMeaningLlmHost: cached.songMeaningLlmHost?.trim() || undefined,
    metaArtist: cached.metaArtist?.trim() || undefined,
    metaTitle: cached.metaTitle?.trim() || undefined,
    manualSaved: cached.manualSaved === true,
    fromLocalCache: true,
  };
}

function lyricsMetaMatchesCache(
  cached: LibraryLyricsCacheRow,
  metaArtist?: string,
  metaTitle?: string
): boolean {
  const wantArtist = metaArtist?.trim() ?? "";
  const wantTitle = metaTitle?.trim() ?? "";
  if (!wantArtist && !wantTitle) return true;
  const gotArtist = cached.metaArtist?.trim() ?? "";
  const gotTitle = cached.metaTitle?.trim() ?? "";
  if (!gotArtist && !gotTitle) return true;
  if (wantArtist && gotArtist && tokenSimilarityForLyrics(wantArtist, gotArtist) < 0.42) return false;
  if (wantTitle && gotTitle && tokenSimilarityForLyrics(wantTitle, gotTitle) < 0.42) return false;
  return true;
}

export function isUsableSavedLyricsCache(
  cached: LibraryLyricsCacheRow | null | undefined,
  opts?: { metaArtist?: string; metaTitle?: string }
): cached is LibraryLyricsCacheRow {
  if (!cached?.pairs?.length) return false;
  const v = cached.lyricsMatchVersion ?? 0;
  if (v < LOCAL_LYRICS_MATCH_VERSION) return false;
  return lyricsMetaMatchesCache(cached, opts?.metaArtist, opts?.metaTitle);
}

/** Add LLM song meaning when missing (e.g. older cached lyrics). */
export async function enrichLocalMp3LyricsWithSongMeaning(
  result: LocalMp3LyricsResult,
  displayName: string,
  libraryTrackId: string,
  signal?: AbortSignal
): Promise<LocalMp3LyricsResult> {
  if (result.songMeaning?.trim()) return result;
  const trackId = libraryTrackId.trim();
  if (trackId && typeof indexedDB !== "undefined") {
    try {
      const cached = await getLibraryLyricsCache(trackId);
      if (cached?.songMeaning?.trim()) {
        return {
          ...mapCachedLibraryLyricsToResult(cached),
          pairs: result.pairs,
          headline: result.headline,
          detectedFranc3: result.detectedFranc3,
          lrclibTrack: result.lrclibTrack,
        };
      }
    } catch {
      /* ignore cache read failures */
    }
  }
  const meta = await resolveTrackMetadataFromLibrary(displayName, libraryTrackId);
  const enriched = await attachSongMeaning(result, meta, displayName, signal);
  if (trackId && enriched.songMeaning) {
    await saveLocalMp3LyricsResultToCache(trackId, enriched);
  }
  return enriched;
}

async function attachSongMeaning(
  result: LocalMp3LyricsResult,
  meta: TrackFileMetadata,
  displayName: string,
  signal?: AbortSignal
): Promise<LocalMp3LyricsResult> {
  if (!result.pairs.length) return result;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const r = await fetchSongMeaningFromLlm(
      {
        artist: meta.artist,
        title: meta.title,
        album: meta.album || undefined,
        displayName,
      },
      signal
    );
    if (r.ok && r.meaning) {
      return {
        ...result,
        songMeaning: r.meaning,
        songMeaningError: undefined,
        songMeaningLlmPurpose: r.llmPurpose || "song meaning",
        songMeaningLlmModel: r.llmModel,
        songMeaningLlmHost: r.llmHost,
        metaArtist: meta.artist || undefined,
        metaTitle: meta.title || undefined,
      };
    }
    return {
      ...result,
      songMeaningError: r.error || "Could not load song meaning.",
      songMeaningLlmPurpose: r.llmPurpose || "song meaning",
      songMeaningLlmModel: r.llmModel,
      songMeaningLlmHost: r.llmHost,
      metaArtist: meta.artist || undefined,
      metaTitle: meta.title || undefined,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...result,
      songMeaningError: msg || "Could not load song meaning.",
      metaArtist: meta.artist || undefined,
      metaTitle: meta.title || undefined,
    };
  }
}

async function finalizeWithLlmSongMeaning(
  result: LocalMp3LyricsResult,
  meta: TrackFileMetadata,
  displayName: string,
  signal?: AbortSignal
): Promise<LocalMp3LyricsResult> {
  if (!(await hasSongMeaningKey()) || !result.pairs.length) return result;
  const enriched = await attachSongMeaning(result, meta, displayName, signal);
  return {
    ...enriched,
    metaArtist: meta.artist || enriched.metaArtist,
    metaTitle: meta.title || enriched.metaTitle,
  };
}

export async function saveLocalMp3LyricsResultToCache(
  trackId: string,
  result: LocalMp3LyricsResult,
  opts?: { manualSaved?: boolean }
): Promise<boolean> {
  if (!trackId || !result.pairs.length || typeof indexedDB === "undefined") return false;
  try {
    await putLibraryLyricsCache(trackId, {
      pairs: result.pairs,
      headline: result.headline,
      detectedFranc3: result.detectedFranc3,
      lrclibTrack: result.lrclibTrack,
      songMeaning: result.songMeaning,
      lyricsLlmPurpose: result.lyricsLlmPurpose,
      lyricsLlmModel: result.lyricsLlmModel,
      lyricsLlmHost: result.lyricsLlmHost,
      songMeaningLlmPurpose: result.songMeaningLlmPurpose,
      songMeaningLlmModel: result.songMeaningLlmModel,
      songMeaningLlmHost: result.songMeaningLlmHost,
      metaArtist: result.metaArtist,
      metaTitle: result.metaTitle,
      lyricsMatchVersion: LOCAL_LYRICS_MATCH_VERSION,
      manualSaved: opts?.manualSaved === true,
    });
    return true;
  } catch {
    /* quota / IndexedDB */
    return false;
  }
}

function coerceGeminiLyricsResult(raw: unknown, fileMeta: TrackFileMetadata, displayName: string): LocalMp3LyricsResult {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Gemini response.");
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) {
    throw new Error(typeof o.error === "string" && o.error.trim() ? o.error.trim() : "Gemini could not load lyrics.");
  }
  const pairsIn = o.pairs;
  if (!Array.isArray(pairsIn) || pairsIn.length === 0) throw new Error("Gemini returned no lyric lines.");
  const pairs: LyricLinePair[] = [];
  for (const row of pairsIn) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const orig = typeof r.orig === "string" ? r.orig.trimEnd() : "";
    const en = typeof r.en === "string" && r.en.trim() ? r.en.trimEnd() : orig;
    if (orig) pairs.push({ orig, en });
  }
  if (!pairs.length) throw new Error("Gemini returned no valid lyric lines.");
  let detectedFranc3 = typeof o.detectedFranc3 === "string" ? o.detectedFranc3.trim().toLowerCase() : "und";
  if (!/^[a-z]{3}$/.test(detectedFranc3)) detectedFranc3 = "und";
  const headline =
    fileMeta.artist?.trim() && fileMeta.title?.trim()
      ? `${fileMeta.artist.trim()} — ${fileMeta.title.trim()}`
      : "Lyrics";
  return {
    pairs,
    headline,
    detectedFranc3,
    lrclibTrack:
      (typeof o.lrclibTrack === "string" && o.lrclibTrack.trim()) ||
      lrclibLabelFromMetadata(fileMeta, displayName),
    songMeaning: typeof o.meaning === "string" && o.meaning.trim() ? o.meaning.trim() : undefined,
    lyricsLlmPurpose: typeof o.llmPurpose === "string" ? o.llmPurpose : "lyrics find + translate (Google Gemini)",
    lyricsLlmModel: typeof o.llmModel === "string" ? o.llmModel : undefined,
    lyricsLlmHost: typeof o.llmHost === "string" ? o.llmHost : undefined,
    songMeaningLlmPurpose:
      typeof o.songMeaningLlmPurpose === "string" ? o.songMeaningLlmPurpose : "song meaning (Google Gemini)",
    songMeaningLlmModel: typeof o.songMeaningLlmModel === "string" ? o.songMeaningLlmModel : undefined,
    songMeaningLlmHost: typeof o.songMeaningLlmHost === "string" ? o.songMeaningLlmHost : undefined,
    metaArtist: fileMeta.artist || undefined,
    metaTitle: fileMeta.title || undefined,
  };
}

export async function fetchGeminiLyricsForLocalMp3(
  displayName: string,
  durationSec: number | null,
  signal?: AbortSignal,
  opts?: { libraryTrackId?: string | null; saveToCache?: boolean }
): Promise<LocalMp3LyricsResult> {
  const ipc = typeof window !== "undefined" ? window.iptv?.lyricsGeminiUnifiedFetch : undefined;
  if (typeof ipc !== "function") throw new Error("Gemini lyrics need the desktop app.");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const trackId = opts?.libraryTrackId?.trim() || "";
  const fileMeta = await resolveTrackMetadataFromLibrary(displayName, trackId);
  const hints = await buildLlmLyricsFetchHints(displayName, fileMeta, trackId);
  const raw = await ipc({
    displayName,
    durationSec,
    metaArtist: fileMeta.artist || undefined,
    metaTitle: fileMeta.title || undefined,
    metaAlbum: fileMeta.album || undefined,
    sourceFileName: hints.sourceFileName,
    altArtist: hints.altArtist,
    altTitle: hints.altTitle,
    playerHeaderLabel: hints.playerHeaderLabel,
  });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const result = coerceGeminiLyricsResult(raw, fileMeta, displayName);
  if (opts?.saveToCache !== false) {
    await saveLocalMp3LyricsResultToCache(trackId, result);
  }
  return result;
}

export async function fetchDeepSeekLyricsForLocalMp3(
  displayName: string,
  durationSec: number | null,
  signal?: AbortSignal,
  opts?: { libraryTrackId?: string | null; saveToCache?: boolean }
): Promise<LocalMp3LyricsResult> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const trackId = opts?.libraryTrackId?.trim() || "";
  const fileMeta = await resolveTrackMetadataFromLibrary(displayName, trackId);
  const unified = await tryUnifiedLlmLyricsWithRetries(
    displayName,
    durationSec,
    fileMeta,
    toLyricsFileMetadata(fileMeta),
    signal,
    trackId
  );
  if (!unified?.pairs.length) {
    throw new Error("DeepSeek could not find lyrics for this track.");
  }
  const headline =
    fileMeta.artist?.trim() && fileMeta.title?.trim()
      ? `${fileMeta.artist.trim()} — ${fileMeta.title.trim()}`
      : "Lyrics";
  let result: LocalMp3LyricsResult = {
    pairs: unified.pairs,
    headline,
    detectedFranc3: unified.detectedFranc3,
    lrclibTrack: unified.lrclibTrack || lrclibLabelFromMetadata(fileMeta, displayName),
    metaArtist: fileMeta.artist || undefined,
    metaTitle: fileMeta.title || undefined,
  };
  result = applyLyricsLlmMeta(
    result,
    unified.llmPurpose || "lyrics find + translate",
    unified.llmModel,
    unified.llmHost
  );
  const meaning = await fetchSongMeaningFromLlm(
    {
      artist: fileMeta.artist,
      title: fileMeta.title,
      album: fileMeta.album || undefined,
      displayName,
      forceOpenAiCompatible: true,
    },
    signal
  );
  if (meaning.ok && meaning.meaning) {
    result = {
      ...result,
      songMeaning: meaning.meaning,
      songMeaningError: undefined,
      songMeaningLlmPurpose: meaning.llmPurpose || "song meaning",
      songMeaningLlmModel: meaning.llmModel,
      songMeaningLlmHost: meaning.llmHost,
    };
  } else if (meaning.error) {
    result = {
      ...result,
      songMeaningError: meaning.error,
      songMeaningLlmPurpose: meaning.llmPurpose || "song meaning",
      songMeaningLlmModel: meaning.llmModel,
      songMeaningLlmHost: meaning.llmHost,
    };
  }
  if (opts?.saveToCache !== false) {
    await saveLocalMp3LyricsResultToCache(trackId, result);
  }
  return result;
}

/**
 * Bilingual lyrics for local tracks using **file tags** (ID3 / FLAC Vorbis / MP4) for artist & title.
 * Desktop + LLM key: unified find+translate, then song meaning, then LRCLIB fallback.
 */
export async function fetchBilingualLyricsForLocalMp3(
  displayName: string,
  durationSec: number | null,
  signal?: AbortSignal,
  opts?: { libraryTrackId?: string | null; saveToCache?: boolean }
): Promise<LocalMp3LyricsResult> {
  const fetchJson = createLyricsJsonFetcher();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const trackId = opts?.libraryTrackId?.trim() || "";
  const fileMeta = await resolveTrackMetadataFromLibrary(displayName, trackId);
  const altMeta = await resolveTrackMetadataFromLibrary(displayName, trackId, { preferFilename: true });
  const searchMetas = buildLrclibSearchMetas(fileMeta, altMeta);
  const useLlmFallback = await hasLyricsLlmKey();

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let best = await lrclibFindBestLyrics(displayName, durationSec, fetchJson, signal, searchMetas);
  if (!best) {
    if (useLlmFallback) {
      try {
        const unified = await tryUnifiedLlmLyricsWithRetries(
          displayName,
          durationSec,
          fileMeta,
          toLyricsFileMetadata(fileMeta),
          signal,
          trackId
        );
        if (unified && unified.pairs.length > 0) {
          const shortHeadline =
            fileMeta.artist?.trim() && fileMeta.title?.trim()
              ? `${fileMeta.artist.trim()} — ${fileMeta.title.trim()}`
              : "Lyrics";
          let result: LocalMp3LyricsResult = {
            pairs: unified.pairs,
            headline: shortHeadline,
            detectedFranc3: unified.detectedFranc3,
            lrclibTrack: unified.lrclibTrack || lrclibLabelFromMetadata(fileMeta, displayName),
            metaArtist: fileMeta.artist || undefined,
            metaTitle: fileMeta.title || undefined,
          };
          result = applyLyricsLlmMeta(
            result,
            unified.llmPurpose || "lyrics find + translate",
            unified.llmModel,
            unified.llmHost
          );
          result = await finalizeWithLlmSongMeaning(result, fileMeta, displayName, signal);
          if (opts?.saveToCache !== false) {
            await saveLocalMp3LyricsResultToCache(trackId, result);
          }
          return result;
        }
      } catch {
        /* use the normal no-lyrics result below */
      }
    }
    return {
      pairs: [],
      headline: "No lyrics found",
      detectedFranc3: "und",
      metaArtist: fileMeta.artist || undefined,
      metaTitle: fileMeta.title || undefined,
    };
  }
  const lines = splitLyricLines(best.plain);
  if (!lines.length) {
    return {
      pairs: [],
      headline: "Lyrics entry was empty.",
      detectedFranc3: "und",
      lrclibTrack: best.record.trackName,
      metaArtist: fileMeta.artist || undefined,
      metaTitle: fileMeta.title || undefined,
    };
  }

  const sample = lines.slice(0, 48).join("\n").slice(0, 3500);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const { franc } = await import("franc-min");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const detected = franc(sample, { minLength: 10 });
  const memSrc = myMemorySourceForFranc3(detected);

  let enLines: string[];
  let lyricsLlmFromTranslation: { purpose: string; model: string; host: string } | null = null;
  if (memSrc == null) {
    enLines = lines.slice();
  } else {
    try {
      const tr = await translateLineBatchesToEnglish(lines, detected, fetchJson, signal);
      enLines = tr.lines;
      if (tr.usedLlm) {
        const ep = await fetchLyricsLlmEndpointInfo();
        lyricsLlmFromTranslation = {
          purpose: "lyrics line translation",
          model: ep.model,
          host: ep.host,
        };
      }
    } catch {
      enLines = lines.slice();
      const ep = await fetchLyricsLlmEndpointInfo();
      lyricsLlmFromTranslation = {
        purpose: "lyrics line translation",
        model: ep.model,
        host: ep.host,
      };
    }
  }

  const pairs: LyricLinePair[] = lines.map((orig, i) => ({
    orig,
    en: enLines[i] ?? orig,
  }));

  const lr = best.record;
  const tagLabel = lrclibLabelFromMetadata(fileMeta, displayName);
  const trackLabel =
    [lr.artistName, lr.trackName].filter(Boolean).join(" — ") ||
    lr.trackName ||
    tagLabel ||
    "match";
  const headline =
    fileMeta.artist?.trim() && fileMeta.title?.trim()
      ? `${fileMeta.artist.trim()} — ${fileMeta.title.trim()}`
      : trackLabel;

  let result: LocalMp3LyricsResult = {
    pairs,
    headline,
    detectedFranc3: detected,
    lrclibTrack: trackLabel,
    metaArtist: fileMeta.artist || undefined,
    metaTitle: fileMeta.title || undefined,
  };
  if (lyricsLlmFromTranslation) {
    result = applyLyricsLlmMeta(
      result,
      lyricsLlmFromTranslation.purpose,
      lyricsLlmFromTranslation.model,
      lyricsLlmFromTranslation.host
    );
  }

  result = await finalizeWithLlmSongMeaning(result, fileMeta, displayName, signal);

  if (opts?.saveToCache !== false) {
    await saveLocalMp3LyricsResultToCache(trackId, result);
  }
  return result;
}
