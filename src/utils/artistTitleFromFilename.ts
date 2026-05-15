import { youtubeSearchQueryFromTrackName } from "./youtubeSearchFromLocalTitle";

export interface ArtistTitleGuess {
  artist: string;
  track: string;
}

/**
 * Best-effort split from common file naming: "Artist - Title", "Artist – Title", "Artist : Title".
 * If no separator, artist is empty and track is the full cleaned title.
 */
export function guessArtistAndTrackFromFilename(displayName: string): ArtistTitleGuess {
  const track = youtubeSearchQueryFromTrackName(displayName).trim();
  if (!track) return { artist: "", track: "" };

  const feat = /^\s*(.+?)\s+(?:feat\.?|ft\.?|featuring)\s+(.+?)\s*[-–—:|]\s*(.+)\s*$/i.exec(track);
  if (feat) {
    const combined = `${feat[1].trim()} ${feat[2].trim()}`.trim();
    const tit = feat[3].trim();
    if (combined.length >= 1 && tit.length >= 1) return { artist: combined, track: tit };
  }

  const m = /^\s*(.+?)\s*[-–—:|]\s*(.+?)\s*$/u.exec(track);
  if (m) {
    const a = m[1].trim();
    const t = m[2].trim();
    if (a.length >= 1 && t.length >= 1) return { artist: a, track: t };
  }
  return { artist: "", track };
}
