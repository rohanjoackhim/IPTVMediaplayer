/**
 * IndexedDB must exist before importing the module under test (it runs at import time in some paths — here it does not).
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileToStoredTrack,
  listAudioLibraryTracks,
  persistStoredTrack,
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

  it("trackFromDesktopPick builds a Blob from main-process payload shape", () => {
    const raw = {
      id: "lib-desk-test",
      name: "chapter1",
      size: 4,
      lastModified: 1,
      addedAt: 2,
      mime: "audio/mpeg",
      data: new Uint8Array([1, 2, 3, 4]).buffer,
    };
    const row = trackFromDesktopPick(raw);
    expect(row.id).toBe("lib-desk-test");
    expect(row.blob.size).toBe(4);
    expect(row.contentType).toBe("audio/mpeg");
  });
});
