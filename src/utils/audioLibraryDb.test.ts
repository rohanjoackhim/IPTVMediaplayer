/**
 * IndexedDB must exist before importing the module under test (it runs at import time in some paths — here it does not).
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileToStoredTrack,
  getLibraryLyricsCache,
  getLibraryLyricsTranslationCache,
  listAudioLibraryTracks,
  persistStoredTrack,
  putLibraryLyricsCache,
  putLibraryLyricsTranslationCache,
  removeAudioLibraryTrack,
  trackFromDesktopPick,
} from "./audioLibraryDb";

const DB_NAME = "iptv-local-audio-v2";

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
    req.onblocked = () => reject(new Error("deleteDatabase blocked"));
  });
}

describe("audioLibraryDb", () => {
  beforeEach(() => deleteDb());
  afterEach(() => deleteDb());

  it("persists a single MP3-shaped file and lists it back with a Blob body", async () => {
    const file = new File([new Uint8Array([255, 251, 144])], "clip.mp3", { type: "" });
    const row = fileToStoredTrack(file);
    expect(row.id).toMatch(/^lib-/);
    expect(row.blob).toBeInstanceOf(Blob);
    await persistStoredTrack(row);
    const list = await listAudioLibraryTracks();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("clip");
    expect(list[0]?.blob).toBeInstanceOf(Blob);
    expect(list[0]?.blob.size).toBeGreaterThan(0);
  });

  it("persists multiple files and returns sorted names", async () => {
    const a = new File([new Uint8Array([1])], "zebra.mp3", { type: "audio/mpeg" });
    const b = new File([new Uint8Array([2])], "alpha.mp3", { type: "audio/mpeg" });
    await persistStoredTrack(fileToStoredTrack(a));
    await persistStoredTrack(fileToStoredTrack(b));
    const list = await listAudioLibraryTracks();
    expect(list.map((x) => x.name)).toEqual(["alpha", "zebra"]);
  });

  it("removeAudioLibraryTrack deletes one row", async () => {
    const row = fileToStoredTrack(new File([new Uint8Array([3])], "gone.mp3", { type: "audio/mpeg" }));
    await persistStoredTrack(row);
    await removeAudioLibraryTrack(row.id);
    const list = await listAudioLibraryTracks();
    expect(list).toHaveLength(0);
  });

  it("putLibraryLyricsCache / getLibraryLyricsCache round-trip; remove clears lyrics", async () => {
    const row = fileToStoredTrack(new File([new Uint8Array([9])], "cached.mp3", { type: "audio/mpeg" }));
    await persistStoredTrack(row);
    await putLibraryLyricsCache(row.id, {
      pairs: [{ orig: "Uno", en: "One" }],
      headline: "LRCLIB: Cached Artist — Cached Song",
      detectedFranc3: "spa",
    });
    const got = await getLibraryLyricsCache(row.id);
    expect(got?.pairs).toHaveLength(1);
    expect(got?.headline).toContain("Cached");
    await removeAudioLibraryTrack(row.id);
    expect(await getLibraryLyricsCache(row.id)).toBeNull();
    expect(await listAudioLibraryTracks()).toHaveLength(0);
  });

  it("caches per-language lyrics translations and preserves them when meaning is saved", async () => {
    const row = fileToStoredTrack(new File([new Uint8Array([10])], "translated.mp3", { type: "audio/mpeg" }));
    await persistStoredTrack(row);
    await putLibraryLyricsCache(row.id, {
      pairs: [{ orig: "Hola", en: "Hello" }],
      headline: "Cached Artist — Cached Song",
      detectedFranc3: "spa",
    });
    await putLibraryLyricsTranslationCache(row.id, "fr", [{ orig: "Hola", en: "Bonjour" }]);

    const cachedFr = await getLibraryLyricsTranslationCache(row.id, "fr");
    expect(cachedFr?.pairs[0]?.en).toBe("Bonjour");

    await putLibraryLyricsCache(row.id, {
      pairs: [{ orig: "Hola", en: "Hello" }],
      headline: "Cached Artist — Cached Song",
      detectedFranc3: "spa",
      songMeaning: "A greeting song.",
    });

    const afterMeaning = await getLibraryLyricsCache(row.id);
    expect(afterMeaning?.songMeaning).toBe("A greeting song.");
    expect(afterMeaning?.translatedTargets?.fr?.pairs[0]?.en).toBe("Bonjour");
  });

  it("trackFromDesktopPick uses the same id as fileToStoredTrack when fileName + size + mtime match", () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    const file = new File([data], "chapter1.mp3", { type: "audio/mpeg", lastModified: 1 });
    const fromBrowser = fileToStoredTrack(file);
    const fromDesk = trackFromDesktopPick({
      fileName: "chapter1.mp3",
      name: "chapter1",
      size: 4,
      lastModified: 1,
      addedAt: 2,
      mime: "audio/mpeg",
      data,
    });
    expect(fromDesk.id).toBe(fromBrowser.id);
    expect(fromDesk.blob.size).toBe(4);
    expect(fromDesk.contentType).toBe("audio/mpeg");
  });

  it("trackFromDesktopPick keeps legacy lib-desk id when payload has no fileName (old Electron)", () => {
    const raw = {
      id: "lib-desk-legacyonly",
      name: "chapter1",
      size: 4,
      lastModified: 1,
      addedAt: 2,
      mime: "audio/mpeg",
      data: new Uint8Array([1, 2, 3, 4]).buffer,
    };
    const row = trackFromDesktopPick({
      fileName: "chapter1.mp3",
      legacyLibDeskId: "lib-desk-legacyonly",
      name: "chapter1",
      size: 4,
      lastModified: 1,
      addedAt: 2,
      mime: "audio/mpeg",
      data: raw.data,
    });
    expect(row.id).toBe("lib-desk-legacyonly");
  });
});
