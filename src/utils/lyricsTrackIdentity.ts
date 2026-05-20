import { guessArtistAndTrackFromFilename } from "./artistTitleFromFilename";
import { normalizeLyricsTitleSource } from "./lyricsQueryVariants";
import type { TrackFileMetadata } from "./resolveTrackMetadata";

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

export function tokenSimilarityForLyrics(a: string, b: string): number {
  const aa = comparableText(a);
  const bb = comparableText(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.86;
  const at = new Set(aa.split(/\s+/).filter((t) => t.length > 1));
  const bt = new Set(bb.split(/\s+/).filter((t) => t.length > 1));
  if (!at.size || !bt.size) return 0;
  let overlap = 0;
  for (const t of at) {
    if (bt.has(t)) overlap += 1;
  }
  return overlap / Math.max(at.size, bt.size);
}

/** Artist/title parsed from a library display name or original file name. */
export function identityFromFilenameLabel(label: string): TrackFileMetadata {
  const guess = guessArtistAndTrackFromFilename(label);
  const norm = normalizeLyricsTitleSource(label);
  const artist = guess.artist.trim();
  const title = (guess.track.trim() || norm).trim();
  return {
    artist,
    title,
    album: "",
    source: artist && title ? "filename" : title || artist ? "display" : "display",
  };
}

function tagsConflictWithFilename(tagMeta: TrackFileMetadata, fileMeta: TrackFileMetadata): boolean {
  if (!tagMeta.title.trim() && !tagMeta.artist.trim()) return false;
  if (!fileMeta.artist.trim() || !fileMeta.title.trim()) return false;
  const titleSim = tokenSimilarityForLyrics(tagMeta.title, fileMeta.title);
  const artistSim = tagMeta.artist.trim()
    ? tokenSimilarityForLyrics(tagMeta.artist, fileMeta.artist)
    : 0.55;
  return titleSim < 0.38 && artistSim < 0.38;
}

/** Prefer filename when embedded tags disagree with the on-disk name (common with bad ID3). */
export function pickBestLyricsIdentity(
  tagMeta: TrackFileMetadata | null,
  fileMeta: TrackFileMetadata | null,
  displayMeta: TrackFileMetadata
): TrackFileMetadata {
  if (tagMeta && fileMeta && tagsConflictWithFilename(tagMeta, fileMeta)) {
    return { ...fileMeta, source: "filename" };
  }
  if (tagMeta?.artist.trim() && tagMeta?.title.trim()) return tagMeta;
  if (fileMeta?.artist.trim() && fileMeta?.title.trim()) return fileMeta;
  if (tagMeta && (tagMeta.title.trim() || tagMeta.artist.trim())) return tagMeta;
  if (fileMeta && (fileMeta.title.trim() || fileMeta.artist.trim())) return fileMeta;
  return displayMeta;
}

export function lyricsMetadataDiffers(a: TrackFileMetadata, b: TrackFileMetadata): boolean {
  if (tokenSimilarityForLyrics(a.artist, b.artist) < 0.5 && a.artist.trim() && b.artist.trim()) return true;
  if (tokenSimilarityForLyrics(a.title, b.title) < 0.5 && a.title.trim() && b.title.trim()) return true;
  return false;
}
