import type { LrclibSearchPlan, LyricsFileMetadata } from "./lyricsQueryVariants";
import { buildLrclibSearchPlans, normalizeLyricsTitleSource } from "./lyricsQueryVariants";
import { guessArtistAndTrackFromFilename } from "./artistTitleFromFilename";
import type { LyricsJsonFetcher } from "./lyricsJsonFetch";
import { stripLrcTimestamps } from "./stripLrcTimestamps";

export interface LrclibRecord {
  id: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

function asRecords(data: unknown): LrclibRecord[] {
  if (!Array.isArray(data)) return [];
  return data as LrclibRecord[];
}

export function plainFromRecord(r: LrclibRecord): string {
  const p = typeof r.plainLyrics === "string" ? r.plainLyrics.trim() : "";
  if (p) return p;
  const s = typeof r.syncedLyrics === "string" ? r.syncedLyrics.trim() : "";
  if (!s) return "";
  return stripLrcTimestamps(s).trim();
}

function isUsableLyricsRecord(r: LrclibRecord): boolean {
  if (r.instrumental) return false;
  return plainFromRecord(r).length > 0;
}

function scoreRecord(r: LrclibRecord, durationSec: number | null): number {
  let score = 0;
  const plain = plainFromRecord(r);
  if (plain.length > 120) score += 55;
  else if (plain.length > 40) score += 48;
  else if (plain.length > 12) score += 40;
  else if (plain.length > 0) score += 28;
  if (typeof r.plainLyrics === "string" && r.plainLyrics.trim().length > 0) score += 8;
  if (r.instrumental) score -= 500;
  const d = typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : null;
  if (durationSec != null && d != null && d > 0) {
    const diff = Math.abs(d - durationSec);
    if (diff <= 1) score += 120;
    else if (diff <= 3) score += 90;
    else if (diff <= 8) score += 45;
    else if (diff <= 20) score += 18;
  }
  return score;
}

function searchPlanToUrl(plan: LrclibSearchPlan): string {
  const u = new URL("https://lrclib.net/api/search");
  if (plan.mode === "q") {
    u.searchParams.set("q", plan.q.slice(0, 200));
  } else {
    u.searchParams.set("track_name", plan.trackName.slice(0, 150));
    u.searchParams.set("artist_name", plan.artistName.slice(0, 150));
  }
  return u.toString();
}

/** All duration × endpoint combos in preference order; first hit wins. */
async function lrclibTryDirectGet(
  artistName: string,
  trackName: string,
  durationSec: number,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal
): Promise<LrclibRecord | null> {
  const artist = artistName.trim() || "Unknown Artist";
  const track = trackName.trim();
  if (!track) return null;
  const album = "Unknown";
  const d0 = Math.max(1, Math.round(durationSec));
  const durationCandidates = [d0, d0 - 1, d0 + 1, d0 - 2, d0 + 2, d0 - 3, d0 + 3].filter((d) => d >= 1);
  const paths = ["/api/get-cached", "/api/get"] as const;

  const combos: { d: number; path: (typeof paths)[number] }[] = [];
  for (const d of durationCandidates) {
    for (const path of paths) {
      combos.push({ d, path });
    }
  }

  const tryOne = async (d: number, path: (typeof paths)[number]): Promise<LrclibRecord | null> => {
    if (signal?.aborted) return null;
    try {
      const u = new URL(`https://lrclib.net${path}`);
      u.searchParams.set("artist_name", artist);
      u.searchParams.set("track_name", track);
      u.searchParams.set("album_name", album);
      u.searchParams.set("duration", String(d));
      const data = await fetchJson(u.toString());
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const r = data as LrclibRecord & { code?: number };
        if (typeof r.code === "number" && r.code === 404) return null;
        if (isUsableLyricsRecord(r)) return r;
      }
    } catch {
      /* 404 / network */
    }
    return null;
  };

  const results = await Promise.all(combos.map((c) => tryOne(c.d, c.path)));
  for (const r of results) {
    if (r) return r;
  }
  return null;
}

async function lrclibMergeDirectGetsForLabel(
  merged: Map<number, LrclibRecord>,
  label: string,
  durationSec: number,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal
): Promise<void> {
  const raw = guessArtistAndTrackFromFilename(label);
  const normArtist = normalizeLyricsTitleSource(raw.artist || "");
  const normTrack = normalizeLyricsTitleSource(raw.track || "");
  const fullTitle = normalizeLyricsTitleSource(label);

  await Promise.all([
    (async () => {
      if (normArtist.length >= 1 && normTrack.length >= 1) {
        const direct = await lrclibTryDirectGet(normArtist, normTrack, durationSec, fetchJson, signal);
        if (direct) merged.set(direct.id, direct);
      }
    })(),
    (async () => {
      if (raw.artist?.trim() && raw.track?.trim()) {
        const direct2 = await lrclibTryDirectGet(raw.artist.trim(), raw.track.trim(), durationSec, fetchJson, signal);
        if (direct2) merged.set(direct2.id, direct2);
      }
    })(),
    (async () => {
      if (fullTitle.length < 3) return;
      const parts = fullTitle.split(/\s+/);
      if (parts.length < 2) return;
      const maybeArtist = parts.slice(0, Math.min(3, parts.length - 1)).join(" ");
      const maybeTrack = parts.slice(Math.min(3, parts.length - 1)).join(" ");
      if (maybeArtist.length < 2 || maybeTrack.length < 2) return;
      const direct3 = await lrclibTryDirectGet(maybeArtist, maybeTrack, durationSec, fetchJson, signal);
      if (direct3) merged.set(direct3.id, direct3);
    })(),
  ]);
}

async function fetchSearchResults(
  plan: LrclibSearchPlan,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal
): Promise<LrclibRecord[]> {
  if (signal?.aborted) return [];
  try {
    const data = await fetchJson(searchPlanToUrl(plan));
    return asRecords(data);
  } catch {
    return [];
  }
}

/** Return best hit early when quality is already high enough to skip remaining search batches. */
function pickUsableIfGoodEnough(
  merged: Map<number, LrclibRecord>,
  durationSec: number | null
): { plain: string; record: LrclibRecord } | null {
  const ranked = [...merged.values()].sort(
    (a, b) => scoreRecord(b, durationSec) - scoreRecord(a, durationSec)
  );
  for (const r of ranked) {
    if (!isUsableLyricsRecord(r)) continue;
    const plain = plainFromRecord(r);
    const sc = scoreRecord(r, durationSec);
    if (plain.length >= 200) return { plain, record: r };
    if (plain.length >= 90 && sc >= 100) return { plain, record: r };
    if (plain.length >= 45 && sc >= 125) return { plain, record: r };
  }
  return null;
}

/**
 * LRCLIB best match using file-tag artist/title first, then library display name / filename.
 */
export async function lrclibFindBestLyrics(
  displayName: string,
  durationSec: number | null,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal,
  fileMeta?: LyricsFileMetadata | null
): Promise<{ plain: string; record: LrclibRecord } | null> {
  const merged = new Map<number, LrclibRecord>();

  if (durationSec != null && durationSec > 2) {
    const tasks: Promise<void>[] = [];
    const tagArtist = fileMeta?.artist?.trim() ?? "";
    const tagTitle = fileMeta?.title?.trim() ?? "";
    if (tagArtist && tagTitle) {
      tasks.push(
        (async () => {
          const direct = await lrclibTryDirectGet(tagArtist, tagTitle, durationSec, fetchJson, signal);
          if (direct) merged.set(direct.id, direct);
        })()
      );
      const normArtist = normalizeLyricsTitleSource(tagArtist);
      const normTitle = normalizeLyricsTitleSource(tagTitle);
      if (normArtist !== tagArtist || normTitle !== tagTitle) {
        tasks.push(
          (async () => {
            const direct = await lrclibTryDirectGet(normArtist, normTitle, durationSec, fetchJson, signal);
            if (direct) merged.set(direct.id, direct);
          })()
        );
      }
      tasks.push(lrclibMergeDirectGetsForLabel(merged, `${tagArtist} - ${tagTitle}`, durationSec, fetchJson, signal));
    }
    tasks.push(lrclibMergeDirectGetsForLabel(merged, displayName, durationSec, fetchJson, signal));
    await Promise.all(tasks);
  }

  const early = pickUsableIfGoodEnough(merged, durationSec);
  if (early) return early;

  const plans = buildLrclibSearchPlans(displayName, fileMeta);
  const batchSize = 8;
  for (let i = 0; i < plans.length; i += batchSize) {
    if (signal?.aborted) break;
    const slice = plans.slice(i, i + batchSize);
    const batches = await Promise.all(slice.map((p) => fetchSearchResults(p, fetchJson, signal)));
    for (const rows of batches) {
      for (const r of rows) {
        if (!merged.has(r.id)) merged.set(r.id, r);
      }
    }
    const quick = pickUsableIfGoodEnough(merged, durationSec);
    if (quick) return quick;
  }

  const ranked = [...merged.values()].sort(
    (a, b) => scoreRecord(b, durationSec) - scoreRecord(a, durationSec)
  );

  for (const r of ranked) {
    if (isUsableLyricsRecord(r)) {
      return { plain: plainFromRecord(r), record: r };
    }
  }
  return null;
}
