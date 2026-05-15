import type { Channel } from "../types";
import { extractAudioMetadata } from "./extractAudioMetadata";
import { extractEmbeddedCoverArt } from "./extractEmbeddedCoverArt";
import { fetchAlbumArtFromInternet } from "./fetchAlbumArtOnline";
import { guessArtistAndTrackFromFilename } from "./artistTitleFromFilename";
import { stableLocalAudioId, stableLocalAudioIdFromMeta } from "./stableLocalAudioId";

/** Helps `<video>` / MSE pick a decoder when `File.type` is empty (common on Windows). */
function mimeFromFileName(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".m4b")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".webm")) return "audio/webm";
  return undefined;
}

/** New database name so a clean library is used after the previous MP3 tab implementation. */
const DB_NAME = "iptv-local-audio-v2";
const STORE = "tracks";
const LYRICS_STORE = "lyrics";
const DB_VERSION = 2;

export interface StoredAudioTrack {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  addedAt: number;
  blob: Blob;
  /** Stable MIME for `<source type>` (Windows often gives empty/`application/octet-stream`). */
  contentType?: string;
  /** Original file name (with extension) when known — helps cover-art sniffing. */
  sourceFileName?: string;
  /** Embedded album art (JPEG/PNG), if extracted. */
  coverArt?: Blob;
  coverArtMime?: string;
}

/** Cached lyrics for a library track (same `id` as `StoredAudioTrack`). */
export interface LibraryLyricsCacheRow {
  trackId: string;
  savedAt: number;
  pairs: { orig: string; en: string }[];
  headline: string;
  detectedFranc3: string;
  lrclibTrack?: string;
  /** LLM explanation of what the song is about (shown after lyrics). */
  songMeaning?: string;
  metaArtist?: string;
  metaTitle?: string;
}

/** Payload from Electron `iptv-pick-local-audio-files` (file read in main process). */
export interface PickedLocalAudioPayload {
  /** Basename with extension (e.g. `Song.mp3`); with size/mtime gives the same id as browser `fileToStoredTrack`. */
  fileName?: string;
  /**
   * Older desktop builds used path-based `lib-desk-*` ids. If present and `fileName` is absent, that id is kept
   * so existing library rows and lyrics cache keys still match.
   */
  legacyLibDeskId?: string;
  /** Display name without extension (same as `fileToStoredTrack`). */
  name: string;
  size: number;
  lastModified: number;
  addedAt: number;
  mime: string;
  data: ArrayBuffer;
}

export function trackFromDesktopPick(raw: PickedLocalAudioPayload): StoredAudioTrack {
  const mime = raw.mime || "audio/mpeg";
  const blob = new Blob([raw.data as BlobPart], { type: mime });
  const legacy = raw.legacyLibDeskId?.trim();
  const fileName = String(raw.fileName ?? "").trim() || `${raw.name}.mp3`;
  const id =
    legacy ||
    stableLocalAudioIdFromMeta({
      fileName,
      size: raw.size,
      lastModified: raw.lastModified,
    });
  return {
    id,
    name: raw.name,
    size: raw.size,
    lastModified: raw.lastModified,
    addedAt: raw.addedAt,
    blob,
    contentType: mime,
    sourceFileName: fileName,
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () =>
      reject(new Error("IndexedDB is blocked. Close other windows of this app and try again."));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LYRICS_STORE)) {
        db.createObjectStore(LYRICS_STORE, { keyPath: "trackId" });
      }
    };
  });
}

function closeDb(db: IDBDatabase) {
  try {
    db.close();
  } catch {
    /* noop */
  }
}

/**
 * Build a Blob for storage/playback without `arrayBuffer()` (which duplicates huge audiobooks in RAM
 * and can fail or freeze). `File.slice` keeps a typed Blob view of the same on-disk bytes.
 */
function fileBodyAsBlob(file: File, mime: string): Blob {
  if (file.size === 0) return new Blob([], { type: mime });
  if (typeof file.slice === "function") return file.slice(0, file.size, mime);
  return new Blob([file], { type: mime });
}

/** Read local file into a storable row (no IndexedDB write yet). */
export function fileToStoredTrack(file: File): StoredAudioTrack {
  const id = stableLocalAudioId(file);
  let mime = (file.type && file.type.trim()) || mimeFromFileName(file.name) || "";
  if (!mime || mime === "application/octet-stream") {
    mime = mimeFromFileName(file.name) || "audio/mpeg";
  }
  const blob = fileBodyAsBlob(file, mime);
  return {
    id,
    name: file.name.replace(/\.[^/.]+$/, "") || file.name,
    size: file.size,
    lastModified: file.lastModified,
    addedAt: Date.now(),
    blob,
    contentType: mime,
    sourceFileName: file.name,
  };
}

function guessExtFromMime(mime?: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("flac")) return ".flac";
  if (m.includes("wav")) return ".wav";
  if (m.includes("aac")) return ".aac";
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("webm")) return ".webm";
  if (m.includes("mp4") || m === "audio/mp4") return ".m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  return ".mp3";
}

function normalizeBlobField(raw: unknown, mime?: string): Blob | undefined {
  if (raw instanceof Blob && raw.size > 0) {
    if (raw.type || !mime) return raw;
    return new Blob([raw], { type: mime });
  }
  if (raw instanceof ArrayBuffer && raw.byteLength > 0) {
    return new Blob([raw], { type: mime || "image/jpeg" });
  }
  if (ArrayBuffer.isView(raw) && raw.byteLength > 0) {
    return new Blob([raw], { type: mime || "image/jpeg" });
  }
  return undefined;
}

/** Ensure Blobs from IndexedDB are usable in the renderer (cover + audio). */
export function normalizeStoredTrackRow(track: StoredAudioTrack): StoredAudioTrack {
  const blob = normalizeBlobField(track.blob, track.contentType || "audio/mpeg");
  if (!(blob instanceof Blob)) return track;
  const coverArt = normalizeBlobField(track.coverArt, track.coverArtMime || "image/jpeg");
  return {
    ...track,
    blob,
    coverArt,
    coverArtMime: coverArt ? track.coverArtMime || coverArt.type || "image/jpeg" : undefined,
  };
}

function trackHasCover(track: StoredAudioTrack): boolean {
  const c = normalizeBlobField(track.coverArt, track.coverArtMime);
  return c instanceof Blob && c.size > 0;
}

/** Embedded cover from tags, then iTunes Search artwork on desktop when missing. */
export async function enrichStoredTrackWithCoverArt(track: StoredAudioTrack): Promise<StoredAudioTrack> {
  const base = normalizeStoredTrackRow(track);
  if (trackHasCover(base)) return base;

  const hint =
    base.sourceFileName?.trim() || `${base.name}${guessExtFromMime(base.contentType)}`;

  try {
    const cov = await extractEmbeddedCoverArt(base.blob, hint);
    if (cov) {
      return normalizeStoredTrackRow({
        ...base,
        coverArt: cov.blob,
        coverArtMime: cov.mime,
      });
    }
  } catch {
    /* try online */
  }

  try {
    const meta = await extractAudioMetadata(base.blob, hint);
    const guess = guessArtistAndTrackFromFilename(base.name);
    const online = await fetchAlbumArtFromInternet({
      artist: meta.artist || guess.artist,
      title: meta.title || guess.track || base.name,
      album: meta.album || undefined,
    });
    if (online) {
      return normalizeStoredTrackRow({
        ...base,
        coverArt: online.blob,
        coverArtMime: online.mime,
      });
    }
  } catch {
    /* noop */
  }

  return base;
}

function readWriteTracksTx(db: IDBDatabase): IDBTransaction {
  return db.transaction(STORE, "readwrite");
}

function readWriteTracksAndLyricsTx(db: IDBDatabase): IDBTransaction {
  return db.transaction([STORE, LYRICS_STORE], "readwrite");
}

function readOnlyTx(db: IDBDatabase): IDBTransaction {
  return db.transaction(STORE, "readonly");
}

export async function listAudioLibraryTracks(): Promise<StoredAudioTrack[]> {
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readOnlyTx(db);
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot open audio library (missing store?): ${String(e)}`);
  }
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      reject(tx.error ?? new Error("read transaction failed"));
    };
    tx.oncomplete = () => closeDb(db);
    const q = tx.objectStore(STORE).getAll();
    q.onerror = () => {
      closeDb(db);
      reject(q.error ?? new Error("getAll failed"));
    };
    q.onsuccess = () => {
      const rows = ((q.result as StoredAudioTrack[]) ?? []).map(normalizeStoredTrackRow);
      rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      resolve(rows);
    };
  });
}

export async function getAudioLibraryTrackById(id: string): Promise<StoredAudioTrack | null> {
  const tid = String(id ?? "").trim();
  if (!tid) return null;
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readOnlyTx(db);
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot open audio library: ${String(e)}`);
  }
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      reject(tx.error ?? new Error("read transaction failed"));
    };
    tx.oncomplete = () => closeDb(db);
    const q = tx.objectStore(STORE).get(tid);
    q.onerror = () => {
      closeDb(db);
      reject(q.error ?? new Error("get failed"));
    };
    q.onsuccess = () => {
      const row = q.result as StoredAudioTrack | undefined;
      if (!row) {
        resolve(null);
        return;
      }
      const norm = normalizeStoredTrackRow(row);
      if (!(norm.blob instanceof Blob)) {
        resolve(null);
        return;
      }
      resolve(norm);
    };
  });
}

/** Persist a row already built in memory (same shape as stored in IDB). */
export async function persistStoredTrack(row: StoredAudioTrack): Promise<void> {
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readWriteTracksTx(db);
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot save audio library: ${String(e)}`);
  }
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      const err = tx.error;
      if (err && (err as DOMException).name === "QuotaExceededError") {
        reject(
          new Error(
            "Disk quota exceeded: the library cannot store more files in this browser. Remove some titles or free disk space."
          )
        );
        return;
      }
      reject(err ?? new Error("IndexedDB could not save the file."));
    };
    tx.oncomplete = () => {
      closeDb(db);
      resolve();
    };
    tx.objectStore(STORE).put(row);
  });
}

export async function putAudioLibraryFile(file: File): Promise<StoredAudioTrack> {
  const row = fileToStoredTrack(file);
  await persistStoredTrack(row);
  return row;
}

/** Remove every track and cached lyrics from the local audio library. */
export async function clearAudioLibrary(): Promise<void> {
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readWriteTracksAndLyricsTx(db);
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot clear audio library: ${String(e)}`);
  }
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      reject(tx.error ?? new Error("IndexedDB could not clear the library."));
    };
    tx.oncomplete = () => {
      closeDb(db);
      resolve();
    };
    tx.objectStore(STORE).clear();
    try {
      tx.objectStore(LYRICS_STORE).clear();
    } catch {
      /* lyrics store may be absent on very old DBs */
    }
  });
}

export async function removeAudioLibraryTrack(id: string): Promise<void> {
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readWriteTracksAndLyricsTx(db);
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot remove from audio library: ${String(e)}`);
  }
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      reject(tx.error ?? new Error("IndexedDB could not remove the track."));
    };
    tx.oncomplete = () => {
      closeDb(db);
      resolve();
    };
    tx.objectStore(STORE).delete(id);
    try {
      tx.objectStore(LYRICS_STORE).delete(id);
    } catch {
      /* ignore */
    }
  });
}

function isValidLyricsRow(row: unknown): row is LibraryLyricsCacheRow {
  if (!row || typeof row !== "object") return false;
  const o = row as Record<string, unknown>;
  if (typeof o.trackId !== "string" || !o.trackId.trim()) return false;
  if (!Array.isArray(o.pairs) || o.pairs.length === 0) return false;
  for (const p of o.pairs) {
    if (!p || typeof p !== "object") return false;
    const q = p as Record<string, unknown>;
    if (typeof q.orig !== "string" || typeof q.en !== "string") return false;
  }
  return typeof o.headline === "string" && o.headline.trim().length > 0 && typeof o.detectedFranc3 === "string";
}

/** Load saved lyrics for this library track id (same id as `StoredAudioTrack.id`). */
export async function getLibraryLyricsCache(trackId: string): Promise<LibraryLyricsCacheRow | null> {
  const id = String(trackId ?? "").trim();
  if (!id) return null;
  const db = await openDb();
  if (!db.objectStoreNames.contains(LYRICS_STORE)) {
    closeDb(db);
    return null;
  }
  let tx: IDBTransaction;
  try {
    tx = db.transaction(LYRICS_STORE, "readonly");
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot read lyrics cache: ${String(e)}`);
  }
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      reject(tx.error ?? new Error("lyrics read transaction failed"));
    };
    tx.oncomplete = () => closeDb(db);
    const q = tx.objectStore(LYRICS_STORE).get(id);
    q.onerror = () => {
      closeDb(db);
      reject(q.error ?? new Error("lyrics get failed"));
    };
    q.onsuccess = () => {
      const row = q.result;
      resolve(isValidLyricsRow(row) ? row : null);
    };
  });
}

/**
 * Save lyrics for this library track (IndexedDB, keyed by the same id as the stored audio blob).
 * The original file on disk is not modified; lyrics travel with the track inside the app library.
 */
export async function putLibraryLyricsCache(
  trackId: string,
  payload: Omit<LibraryLyricsCacheRow, "trackId" | "savedAt">
): Promise<void> {
  const id = String(trackId ?? "").trim();
  if (!id || !payload.pairs?.length) return;
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = db.transaction(LYRICS_STORE, "readwrite");
  } catch (e) {
    closeDb(db);
    throw e instanceof Error ? e : new Error(`Cannot save lyrics cache: ${String(e)}`);
  }
  const row: LibraryLyricsCacheRow = {
    trackId: id,
    savedAt: Date.now(),
    pairs: payload.pairs,
    headline: payload.headline,
    detectedFranc3: payload.detectedFranc3,
    lrclibTrack: payload.lrclibTrack,
    songMeaning: payload.songMeaning?.trim() || undefined,
    metaArtist: payload.metaArtist?.trim() || undefined,
    metaTitle: payload.metaTitle?.trim() || undefined,
  };
  return new Promise((resolve, reject) => {
    tx.onerror = () => {
      closeDb(db);
      reject(tx.error ?? new Error("IndexedDB could not save lyrics."));
    };
    tx.oncomplete = () => {
      closeDb(db);
      resolve();
    };
    tx.objectStore(LYRICS_STORE).put(row);
  });
}

export function channelFromLibraryTrack(
  track: StoredAudioTrack,
  objectUrl: string,
  opts?: { restartNonce?: number }
): Channel {
  const t =
    track.contentType?.trim() ||
    (track.blob.type && track.blob.type !== "application/octet-stream" ? track.blob.type.trim() : "") ||
    "audio/mpeg";
  const ch: Channel = {
    id: `audio-lib-${track.id}`,
    name: track.name,
    url: objectUrl,
    group: "Audio",
    libraryTrackId: track.id,
    libraryContentType: t,
  };
  const n = opts?.restartNonce;
  if (typeof n === "number") ch.libraryRestartNonce = n;
  return ch;
}
