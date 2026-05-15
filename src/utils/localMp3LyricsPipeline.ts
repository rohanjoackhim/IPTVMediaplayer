import type { LibraryLyricsCacheRow } from "./audioLibraryDb";
import { putLibraryLyricsCache } from "./audioLibraryDb";
import { fetchLyricsLlmEndpointInfo, hasLyricsLlmKey, hasSongMeaningKey } from "./lyricsLlmEndpointLabel";
import { createLyricsJsonFetcher } from "./lyricsJsonFetch";
import { tryUnifiedLlmLyrics } from "./llmUnifiedLyricsIpc";
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
    metaArtist: cached.metaArtist?.trim() || undefined,
    metaTitle: cached.metaTitle?.trim() || undefined,
  };
}

/** Add LLM song meaning when missing (e.g. older cached lyrics). */
export async function enrichLocalMp3LyricsWithSongMeaning(
  result: LocalMp3LyricsResult,
  displayName: string,
  libraryTrackId: string,
  signal?: AbortSignal
): Promise<LocalMp3LyricsResult> {
  if (result.songMeaning?.trim()) return result;
  const meta = await resolveTrackMetadataFromLibrary(displayName, libraryTrackId);
  const enriched = await attachSongMeaning(result, meta, displayName, signal);
  if (libraryTrackId.trim() && enriched.songMeaning) {
    await saveLyricsCache(libraryTrackId.trim(), enriched);
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

async function saveLyricsCache(trackId: string, result: LocalMp3LyricsResult): Promise<void> {
  if (!trackId || !result.pairs.length || typeof indexedDB === "undefined") return;
  try {
    await putLibraryLyricsCache(trackId, {
      pairs: result.pairs,
      headline: result.headline,
      detectedFranc3: result.detectedFranc3,
      lrclibTrack: result.lrclibTrack,
      songMeaning: result.songMeaning,
      metaArtist: result.metaArtist,
      metaTitle: result.metaTitle,
    });
  } catch {
    /* quota / IndexedDB */
  }
}

/**
 * Bilingual lyrics for local tracks using **file tags** (ID3 / FLAC Vorbis / MP4) for artist & title.
 * Desktop + LLM key: unified find+translate, then song meaning, then LRCLIB fallback.
 */
export async function fetchBilingualLyricsForLocalMp3(
  displayName: string,
  durationSec: number | null,
  signal?: AbortSignal,
  opts?: { libraryTrackId?: string | null }
): Promise<LocalMp3LyricsResult> {
  const fetchJson = createLyricsJsonFetcher();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const trackId = opts?.libraryTrackId?.trim() || "";
  const fileMeta = await resolveTrackMetadataFromLibrary(displayName, trackId);
  const lyricsMeta = toLyricsFileMetadata(fileMeta);
  const useLlmFirst = await hasLyricsLlmKey();

  if (useLlmFirst) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const unified = await tryUnifiedLlmLyrics(displayName, durationSec, lyricsMeta, signal);
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
        await saveLyricsCache(trackId, result);
        return result;
      }
    } catch {
      /* unified LLM failed; continue to LRCLIB */
    }
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const best = await lrclibFindBestLyrics(displayName, durationSec, fetchJson, signal, lyricsMeta);
  if (!best) {
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

  await saveLyricsCache(trackId, result);
  return result;
}
