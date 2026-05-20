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

function expectedIdentity(
  displayName: string,
  fileMeta?: LyricsFileMetadata | null
): { artist: string; title: string; album: string } {
  const metaArtist = fileMeta?.artist?.trim() ?? "";
  const metaTitle = fileMeta?.title?.trim() ?? "";
  const album = fileMeta?.album?.trim() ?? "";
  const guess = guessArtistAndTrackFromFilename(displayName);
  const displayTitle = guess.track.trim() || normalizeLyricsTitleSource(displayName);
  if (metaArtist || metaTitle) {
    return {
      artist: metaArtist,
      title: metaTitle || displayTitle,
      album,
    };
  }
  return { artist: guess.artist.trim(), title: displayTitle, album };
}

function identityQuality(
  r: LrclibRecord,
  expected: { artist: string; title: string; album: string }
): number {
  const titleScore = expected.title ? tokenSimilarity(expected.title, r.trackName ?? "") : 0.62;
  const artistScore = expected.artist ? tokenSimilarity(expected.artist, r.artistName ?? "") : 0.62;
  const albumScore = expected.album ? tokenSimilarity(expected.album, r.albumName ?? "") : 0;
  if (!expected.title && !expected.artist) return 0.5;
  if (expected.artist) {
    let score = titleScore * 0.62 + artistScore * 0.3;
    if (expected.album) score += albumScore * 0.08;
    return score;
  }
  return titleScore;
}

type ExpectedIdentity = { artist: string; title: string; album: string };
type IdentityMatchTier = "strict" | "relaxed" | "duration";

/** Minimum composite identity for the strict tier (wrong-song guard). */
const MIN_ACCEPT_IDENTITY_STRICT = 0.64;

function durationDeltaSec(r: LrclibRecord, durationSec: number | null): number | null {
  const d = typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : null;
  if (durationSec == null || d == null) return null;
  return Math.abs(d - durationSec);
}

function isDurationClose(r: LrclibRecord, durationSec: number | null, maxSec = 8): boolean {
  const diff = durationDeltaSec(r, durationSec);
  return diff != null && diff <= maxSec;
}

function isDurationTrusted(r: LrclibRecord, durationSec: number | null): boolean {
  const diff = durationDeltaSec(r, durationSec);
  return diff != null && diff <= 3;
}

function bestIdentityQuality(r: LrclibRecord, expectedList: ExpectedIdentity[]): number {
  if (!expectedList.length) return 0.5;
  return Math.max(...expectedList.map((e) => identityQuality(r, e)));
}

function recordMatchesExpected(
  r: LrclibRecord,
  expected: ExpectedIdentity,
  durationSec: number | null,
  tier: IdentityMatchTier
): boolean {
  const titleScore = expected.title ? tokenSimilarity(expected.title, r.trackName ?? "") : 0.7;
  const artistScore = expected.artist ? tokenSimilarity(expected.artist, r.artistName ?? "") : 0.7;
  const identity = identityQuality(r, expected);
  const durationClose = isDurationClose(r, durationSec);
  const durationTrusted = isDurationTrusted(r, durationSec);
  const plainLen = plainFromRecord(r).length;

  if (tier === "duration") {
    if (!durationTrusted) return false;
    if (expected.title && titleScore < 0.48) return false;
    if (expected.artist && artistScore < 0.32) return false;
    return identity >= 0.46 && plainLen >= 24;
  }

  if (tier === "relaxed") {
    if (expected.title && titleScore < 0.54) return false;
    if (expected.artist && artistScore < 0.38 && !durationClose) return false;
    if (expected.artist && artistScore < 0.3) return false;
    const minIdentity = durationClose ? 0.52 : 0.56;
    return identity >= minIdentity;
  }

  if (expected.title && titleScore < 0.6) return false;
  if (expected.artist && artistScore < 0.46 && !durationClose) return false;
  if (expected.artist && artistScore < 0.36) return false;
  const minIdentity = durationTrusted
    ? MIN_ACCEPT_IDENTITY_STRICT - 0.1
    : durationClose
      ? MIN_ACCEPT_IDENTITY_STRICT - 0.06
      : MIN_ACCEPT_IDENTITY_STRICT;
  return identity >= minIdentity;
}

function matchesAnyExpected(
  r: LrclibRecord,
  expectedList: ExpectedIdentity[],
  durationSec: number | null,
  tier: IdentityMatchTier
): boolean {
  return expectedList.some((e) => recordMatchesExpected(r, e, durationSec, tier));
}

function collectExpectedIdentities(
  displayName: string,
  fileMeta?: LyricsFileMetadata | LyricsFileMetadata[] | null
): ExpectedIdentity[] {
  const seen = new Set<string>();
  const out: ExpectedIdentity[] = [];
  const push = (fm?: LyricsFileMetadata | null) => {
    const e = expectedIdentity(displayName, fm);
    const key = comparableText(`${e.artist}\0${e.title}`);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  if (Array.isArray(fileMeta)) {
    for (const m of fileMeta) push(m);
  } else {
    push(fileMeta ?? null);
  }
  return out.length ? out : [expectedIdentity(displayName, null)];
}

function scoreRecord(
  r: LrclibRecord,
  durationSec: number | null,
  expectedList: ExpectedIdentity[]
): number {
  const identity = bestIdentityQuality(r, expectedList);
  let score = 0;
  const plain = plainFromRecord(r);
  const lengthBonus =
    identity >= 0.78
      ? plain.length > 120
        ? 55
        : plain.length > 40
          ? 48
          : plain.length > 12
            ? 40
            : plain.length > 0
              ? 28
              : 0
      : plain.length > 120
        ? 18
        : plain.length > 40
          ? 22
          : plain.length > 12
            ? 16
            : plain.length > 0
              ? 10
              : 0;
  score += lengthBonus;
  if (typeof r.plainLyrics === "string" && r.plainLyrics.trim().length > 0) score += 8;
  if (r.instrumental) score -= 500;
  score += Math.round(identity * 240);
  if (identity < 0.55) score -= 280;
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

function selectBestFromMerged(
  merged: Map<number, LrclibRecord>,
  durationSec: number | null,
  expectedList: ExpectedIdentity[],
  tier: IdentityMatchTier
): { plain: string; record: LrclibRecord } | null {
  const ranked = [...merged.values()].sort(
    (a, b) => scoreRecord(b, durationSec, expectedList) - scoreRecord(a, durationSec, expectedList)
  );
  for (const r of ranked) {
    if (!isUsableLyricsRecord(r)) continue;
    if (!matchesAnyExpected(r, expectedList, durationSec, tier)) continue;
    return { plain: plainFromRecord(r), record: r };
  }
  return null;
}

/** Return best hit early when quality is already high enough to skip remaining search batches. */
function pickUsableIfGoodEnough(
  merged: Map<number, LrclibRecord>,
  durationSec: number | null,
  expectedList: ExpectedIdentity[]
): { plain: string; record: LrclibRecord } | null {
  const ranked = [...merged.values()].sort(
    (a, b) => scoreRecord(b, durationSec, expectedList) - scoreRecord(a, durationSec, expectedList)
  );
  for (const r of ranked) {
    if (!isUsableLyricsRecord(r)) continue;
    if (!matchesAnyExpected(r, expectedList, durationSec, "strict")) continue;
    const plain = plainFromRecord(r);
    const identity = bestIdentityQuality(r, expectedList);
    if (identity < MIN_ACCEPT_IDENTITY_STRICT) continue;
    const sc = scoreRecord(r, durationSec, expectedList);
    if (plain.length >= 120 && identity >= 0.78) return { plain, record: r };
    if (plain.length >= 60 && sc >= 200 && identity >= 0.72) return { plain, record: r };
    if (plain.length >= 30 && sc >= 240 && identity >= 0.76) return { plain, record: r };
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
  fileMeta?: LyricsFileMetadata | LyricsFileMetadata[] | null
): Promise<{ plain: string; record: LrclibRecord } | null> {
  const merged = new Map<number, LrclibRecord>();
  const expectedList = collectExpectedIdentities(displayName, fileMeta);
  const metaList = Array.isArray(fileMeta) ? fileMeta : fileMeta ? [fileMeta] : [];

  if (durationSec != null && durationSec > 2) {
    const tasks: Promise<void>[] = [];
    const directPairs = new Set<string>();
    const queueDirect = (artist: string, title: string) => {
      const a = artist.trim();
      const t = title.trim();
      if (!a || !t) return;
      const key = `${a.toLowerCase()}\0${t.toLowerCase()}`;
      if (directPairs.has(key)) return;
      directPairs.add(key);
      tasks.push(
        (async () => {
          const direct = await lrclibTryDirectGet(a, t, durationSec, fetchJson, signal);
          if (direct) merged.set(direct.id, direct);
        })()
      );
      const normArtist = normalizeLyricsTitleSource(a);
      const normTitle = normalizeLyricsTitleSource(t);
      if (normArtist !== a || normTitle !== t) queueDirect(normArtist, normTitle);
    };

    for (const m of metaList) {
      const tagArtist = m.artist?.trim() ?? "";
      const tagTitle = m.title?.trim() ?? "";
      if (tagArtist && tagTitle) {
        queueDirect(tagArtist, tagTitle);
        tasks.push(lrclibMergeDirectGetsForLabel(merged, `${tagArtist} - ${tagTitle}`, durationSec, fetchJson, signal));
      } else if (tagTitle) {
        tasks.push(lrclibMergeDirectGetsForLabel(merged, tagTitle, durationSec, fetchJson, signal));
      }
    }
    tasks.push(lrclibMergeDirectGetsForLabel(merged, displayName, durationSec, fetchJson, signal));
    await Promise.all(tasks);
  }

  const early = pickUsableIfGoodEnough(merged, durationSec, expectedList);
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
    const quick = pickUsableIfGoodEnough(merged, durationSec, expectedList);
    if (quick) return quick;
  }

  for (const tier of ["strict", "relaxed", "duration"] as const) {
    const hit = selectBestFromMerged(merged, durationSec, expectedList, tier);
    if (hit) return hit;
  }
  return null;
}
