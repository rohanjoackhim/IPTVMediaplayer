import { guessArtistAndTrackFromFilename } from "./artistTitleFromFilename";
import { youtubeSearchQueryFromTrackName } from "./youtubeSearchFromLocalTitle";

/** LRCLIB search plan: keyword `q` and/or structured track + artist. */
export type LrclibSearchPlan =
  | { mode: "q"; q: string }
  | { mode: "trackArtist"; trackName: string; artistName: string };

/** Artist/title from file tags (ID3, FLAC Vorbis, MP4) — used before filename guesses. */
export interface LyricsFileMetadata {
  artist: string;
  title: string;
  album?: string;
}

function stripBracketTags(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]{0,80}\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove leading track index like "01.", "12 -", "3_". */
function stripLeadingTrackIndex(s: string): string {
  return s.replace(/^\d{1,3}[\s.\-_):]+\s*/i, "").trim();
}

/** Strip common junk from file / library display names. */
export function normalizeLyricsTitleSource(displayName: string): string {
  let s = youtubeSearchQueryFromTrackName(displayName).trim();
  s = stripBracketTags(s);
  s = stripLeadingTrackIndex(s);
  s = s
    .replace(/\b(official|lyrics|video|audio|hd|hq|320|128|kbps|mp3|flac)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 200);
}

function uniqStrings(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const t = x.trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function buildPlansForOneLabel(label: string): LrclibSearchPlan[] {
  const full = normalizeLyricsTitleSource(label);
  const rawGuess = guessArtistAndTrackFromFilename(label);
  const normGuess = {
    artist: normalizeLyricsTitleSource(rawGuess.artist || ""),
    track: normalizeLyricsTitleSource(rawGuess.track || ""),
  };

  const qVariants = uniqStrings([
    full,
    rawGuess.artist && rawGuess.track ? `${rawGuess.artist} ${rawGuess.track}` : "",
    rawGuess.artist && rawGuess.track ? `${rawGuess.track} ${rawGuess.artist}` : "",
    normGuess.artist && normGuess.track ? `${normGuess.artist} ${normGuess.track}` : "",
    normGuess.track || full,
    normGuess.artist && normGuess.track ? normGuess.track : "",
    full.split(/\s+/).slice(0, 8).join(" "),
  ]);

  const plans: LrclibSearchPlan[] = [];
  for (const q of qVariants) {
    if (q.length >= 2) plans.push({ mode: "q", q });
  }

  const artistTrackPairs: { a: string; t: string }[] = [];
  if (normGuess.artist.length >= 1 && normGuess.track.length >= 1) {
    artistTrackPairs.push({ a: normGuess.artist, t: normGuess.track });
  }
  if (rawGuess.artist && rawGuess.track && (rawGuess.artist !== normGuess.artist || rawGuess.track !== normGuess.track)) {
    artistTrackPairs.push({ a: rawGuess.artist.trim(), t: rawGuess.track.trim() });
  }

  for (const { a, t } of artistTrackPairs) {
    if (a.length >= 1 && t.length >= 1) {
      plans.push({ mode: "trackArtist", trackName: t.slice(0, 120), artistName: a.slice(0, 120) });
      plans.push({ mode: "trackArtist", trackName: t.slice(0, 120), artistName: a.slice(0, 80) });
    }
  }
  return plans;
}

function buildTitleOnlyPlans(title: string): LrclibSearchPlan[] {
  const t = normalizeLyricsTitleSource(title);
  if (t.length < 3) return [];
  const words = t.split(/\s+/).filter(Boolean);
  const plans: LrclibSearchPlan[] = [
    { mode: "q", q: t.slice(0, 200) },
    { mode: "trackArtist", trackName: t.slice(0, 120), artistName: "Unknown Artist" },
  ];
  if (words.length > 3) {
    plans.push({ mode: "q", q: words.slice(0, 8).join(" ").slice(0, 200) });
  }
  return plans;
}

function buildPlansFromFileMetadata(fileMeta: LyricsFileMetadata): LrclibSearchPlan[] {
  const artist = normalizeLyricsTitleSource(fileMeta.artist || "");
  const title = normalizeLyricsTitleSource(fileMeta.title || "");
  if (!title) return [];
  if (!artist) return buildTitleOnlyPlans(title);
  const label = `${artist} - ${title}`;
  const plans = buildPlansForOneLabel(label);
  const extra: LrclibSearchPlan[] = [
    { mode: "trackArtist", trackName: title.slice(0, 120), artistName: artist.slice(0, 120) },
    { mode: "trackArtist", trackName: title.slice(0, 120), artistName: artist.slice(0, 80) },
    { mode: "trackArtist", trackName: artist.slice(0, 120), artistName: title.slice(0, 120) },
    { mode: "q", q: `${artist} - ${title}`.slice(0, 200) },
    { mode: "q", q: `${artist} ${title}`.slice(0, 200) },
    { mode: "q", q: `${title} ${artist}`.slice(0, 200) },
    { mode: "q", q: `${title} - ${artist}`.slice(0, 200) },
  ];
  if (fileMeta.album?.trim()) {
    extra.push({ mode: "q", q: `${artist} ${title} ${normalizeLyricsTitleSource(fileMeta.album)}`.slice(0, 200) });
  }
  return [...extra, ...plans];
}

/**
 * Build LRCLIB search attempts. When `fileMeta` has tag artist + title, those plans are tried first.
 */
export function buildLrclibSearchPlans(
  displayName: string,
  fileMeta?: LyricsFileMetadata | LyricsFileMetadata[] | null
): LrclibSearchPlan[] {
  const seen = new Set<string>();
  const deduped: LrclibSearchPlan[] = [];

  const push = (p: LrclibSearchPlan) => {
    const key = p.mode === "q" ? `q:${p.q.toLowerCase()}` : `ta:${p.artistName.toLowerCase()}|${p.trackName.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(p);
  };

  const pushMeta = (m: LyricsFileMetadata) => {
    if (m.title?.trim()) {
      for (const p of buildPlansFromFileMetadata(m)) push(p);
    } else if (m.artist?.trim()) {
      for (const p of buildPlansForOneLabel(m.artist)) push(p);
    }
  };

  if (Array.isArray(fileMeta)) {
    for (const m of fileMeta) pushMeta(m);
  } else if (fileMeta) {
    pushMeta(fileMeta);
  }
  for (const p of buildPlansForOneLabel(displayName)) push(p);

  return deduped.slice(0, 42);
}
