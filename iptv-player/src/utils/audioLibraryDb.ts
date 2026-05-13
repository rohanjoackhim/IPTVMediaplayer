import type { Channel } from "../types";
import { stableLocalAudioId } from "./stableLocalAudioId";

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
const DB_VERSION = 1;

export interface StoredAudioTrack {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  addedAt: number;
  blob: Blob;
  /** Stable MIME for `<source type>` (Windows often gives empty/`application/octet-stream`). */
  contentType?: string;
}

/** Payload from Electron `iptv-pick-local-audio-files` (file read in main process). */
export interface PickedLocalAudioPayload {
  id: string;
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
  return {
    id: raw.id,
    name: raw.name,
    size: raw.size,
    lastModified: raw.lastModified,
    addedAt: raw.addedAt,
    blob,
    contentType: mime,
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
  };
}

function readWriteTx(db: IDBDatabase): IDBTransaction {
  return db.transaction(STORE, "readwrite");
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
      const rows = (q.result as StoredAudioTrack[]) ?? [];
      rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      resolve(rows);
    };
  });
}

/** Persist a row already built in memory (same shape as stored in IDB). */
export async function persistStoredTrack(row: StoredAudioTrack): Promise<void> {
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readWriteTx(db);
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

export async function removeAudioLibraryTrack(id: string): Promise<void> {
  const db = await openDb();
  let tx: IDBTransaction;
  try {
    tx = readWriteTx(db);
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
  });
}

export function channelFromLibraryTrack(track: StoredAudioTrack, objectUrl: string): Channel {
  const t =
    track.contentType?.trim() ||
    (track.blob.type && track.blob.type !== "application/octet-stream" ? track.blob.type.trim() : "") ||
    "audio/mpeg";
  return {
    id: `audio-lib-${track.id}`,
    name: track.name,
    url: objectUrl,
    group: "MP3 & audiobooks",
    libraryTrackId: track.id,
    libraryContentType: t,
  };
}
