import { getAudioLibraryTrackById } from "./audioLibraryDb";
import { extractAudioMetadata } from "./extractAudioMetadata";
import { guessArtistAndTrackFromFilename } from "./artistTitleFromFilename";
import { identityFromFilenameLabel, pickBestLyricsIdentity } from "./lyricsTrackIdentity";

export interface TrackFileMetadata {
  artist: string;
  title: string;
  album: string;
  /** Where artist/title primarily came from. */
  source: "tags" | "filename" | "display";
}

function guessExtFromMime(mime?: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("flac")) return ".flac";
  if (m.includes("wav")) return ".wav";
  if (m.includes("aac")) return ".aac";
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mp4") || m === "audio/mp4") return ".m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  return ".mp3";
}

function pickIdentityFromTags(
  meta: { title: string; artist: string; album: string },
  displayName: string
): TrackFileMetadata {
  const guess = guessArtistAndTrackFromFilename(displayName);
  const title = meta.title.trim() || guess.track || displayName.trim();
  const artist = meta.artist.trim() || guess.artist;
  const album = meta.album.trim();
  const fromTags = !!(meta.title.trim() || meta.artist.trim());
  return {
    artist,
    title,
    album,
    source: fromTags ? "tags" : guess.artist || guess.track ? "filename" : "display",
  };
}

/**
 * Artist / title / album from embedded tags (ID3, Vorbis/FLAC, MP4) with filename fallback.
 * Pass `libraryTrackId` to read tags from the stored audio blob.
 */
export async function resolveTrackMetadataFromLibrary(
  displayName: string,
  libraryTrackId?: string | null,
  opts?: { preferFilename?: boolean }
): Promise<TrackFileMetadata> {
  const displayMeta = identityFromFilenameLabel(displayName);
  const tid = String(libraryTrackId ?? "").trim();

  let tagMeta: TrackFileMetadata | null = null;
  let fileMeta: TrackFileMetadata | null = null;

  if (tid) {
    try {
      const row = await getAudioLibraryTrackById(tid);
      if (row) {
        const fileLabel = row.sourceFileName?.trim() || row.name?.trim() || "";
        if (fileLabel) {
          fileMeta = identityFromFilenameLabel(fileLabel);
        }
        const persistedArtist = row.tagArtist?.trim() ?? "";
        const persistedTitle = row.tagTitle?.trim() ?? "";
        if (persistedArtist || persistedTitle) {
          tagMeta = {
            artist: persistedArtist,
            title: persistedTitle || displayName.trim(),
            album: "",
            source: "tags",
          };
        } else if (row.blob instanceof Blob) {
          const hint = fileLabel || `${row.name}${guessExtFromMime(row.contentType)}`;
          const meta = await extractAudioMetadata(row.blob, hint);
          tagMeta = pickIdentityFromTags(meta, displayName);
        }
      }
    } catch {
      /* fall through */
    }
  }

  if (opts?.preferFilename) {
    return fileMeta?.artist.trim() && fileMeta?.title.trim()
      ? fileMeta
      : displayMeta.artist.trim() && displayMeta.title.trim()
        ? displayMeta
        : fileMeta ?? tagMeta ?? displayMeta;
  }

  return pickBestLyricsIdentity(tagMeta, fileMeta, displayMeta);
}

/** Label for LRCLIB / LLM when tags supply artist + title. */
export function lrclibLabelFromMetadata(meta: TrackFileMetadata, displayName: string): string {
  const a = meta.artist.trim();
  const t = meta.title.trim();
  if (a && t) return `${a} — ${t}`;
  if (t) return t;
  if (a) return a;
  return displayName.trim();
}
