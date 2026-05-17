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

function comparableText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(feat|ft|featuring)\b\.?/g, " ")
    .replace(/\b(remaster(?:ed)?|remix|radio edit|explicit|clean|mono|stereo|version|edit|live|official|lyrics?)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textTokens(s: string): Set<string> {
  return new Set(comparableText(s).split(/\s+/).filter((t) => t.length > 1));
}

function tokenSimilarity(a: string, b: string): number {
  const aa = comparableText(a);
  const bb = comparableText(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.86;
  const at = textTokens(aa);
  const bt = textTokens(bb);
  if (!at.size || !bt.size) return 0;
  let overlap = 0;
  for (const t of at) {
    if (bt.has(t)) overlap += 1;
  }
  return overlap / Math.max(at.size, bt.size);
}

function expectedIdentity(displayName: string, fileMeta?: LyricsFileMetadata | null): { artist: string; title: string } {
  const metaArtist = fileMeta?.artist?.trim() ?? "";
  const metaTitle = fileMeta?.title?.trim() ?? "";
  if (metaArtist || metaTitle) return { artist: metaArtist, title: metaTitle };
  const guess = guessArtistAndTrackFromFilename(displayName);
  return { artist: guess.artist.trim(), title: guess.track.trim() || normalizeLyricsTitleSource(displayName) };
}

function identityQuality(r: LrclibRecord, expected: { artist: string; title: string }): number {
  const titleScore = tokenSimilarity(expected.title, r.trackName ?? "");
  const artistScore = expected.artist ? tokenSimilarity(expected.artist, r.artistName ?? "") : 0.62;
  if (!expected.title && !expected.artist) return 0.5;
  if (expected.artist) return titleScore * 0.68 + artistScore * 0.32;
  return titleScore;
}

function isPlausibleIdentityMatch(r: LrclibRecord, expected: { artist: string; title: string }, durationSec: number | null): boolean {
  const titleScore = tokenSimilarity(expected.title, r.trackName ?? "");
  const artistScore = expected.artist ? tokenSimilarity(expected.artist, r.artistName ?? "") : 0.7;
  const d = typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : null;
  const durationClose = durationSec != null && d != null && Math.abs(d - durationSec) <= 8;
  if (expected.title && titleScore < 0.55) return false;
  if (expected.artist && artistScore < 0.34 && !durationClose) return false;
  return true;
}

function scoreRecord(r: LrclibRecord, durationSec: number | null, expected: { artist: string; title: string }): number {
  let score = 0;
  const plain = plainFromRecord(r);
  if (plain.length > 120) score += 55;
  else if (plain.length > 40) score += 48;
  else if (plain.length > 12) score += 40;
  else if (plain.length > 0) score += 28;
  if (typeof r.plainLyrics === "string" && r.plainLyrics.trim().length > 0) score += 8;
  if (r.instrumental) score -= 500;
  score += Math.round(identityQuality(r, expected) * 160);
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
  durationSec: number | null,
  expected: { artist: string; title: string }
): { plain: string; record: LrclibRecord } | null {
  const ranked = [...merged.values()].sort(
    (a, b) => scoreRecord(b, durationSec, expected) - scoreRecord(a, durationSec, expected)
  );
  for (const r of ranked) {
    if (!isUsableLyricsRecord(r)) continue;
    if (!isPlausibleIdentityMatch(r, expected, durationSec)) continue;
    const plain = plainFromRecord(r);
    const sc = scoreRecord(r, durationSec, expected);
    const identity = identityQuality(r, expected);
    if (plain.length >= 200 && identity >= 0.78) return { plain, record: r };
    if (plain.length >= 90 && sc >= 190 && identity >= 0.66) return { plain, record: r };
    if (plain.length >= 45 && sc >= 230 && identity >= 0.74) return { plain, record: r };
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
  const expected = expectedIdentity(displayName, fileMeta);

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

  const early = pickUsableIfGoodEnough(merged, durationSec, expected);
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
    const quick = pickUsableIfGoodEnough(merged, durationSec, expected);
    if (quick) return quick;
  }

  const ranked = [...merged.values()].sort(
    (a, b) => scoreRecord(b, durationSec, expected) - scoreRecord(a, durationSec, expected)
  );

  for (const r of ranked) {
    if (isUsableLyricsRecord(r) && isPlausibleIdentityMatch(r, expected, durationSec)) {
      return { plain: plainFromRecord(r), record: r };
    }
  }
  return null;
}
