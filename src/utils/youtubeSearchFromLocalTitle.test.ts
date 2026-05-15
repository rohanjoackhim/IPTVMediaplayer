import { describe, expect, it } from "vitest";
import { isLikelyLocalMp3Channel, youtubeSearchQueryFromTrackName } from "./youtubeSearchFromLocalTitle";
import type { Channel } from "../types";

describe("youtubeSearchQueryFromTrackName", () => {
  it("strips mp3 extension and underscores", () => {
    expect(youtubeSearchQueryFromTrackName("The_Beatles_-_Help!.mp3")).toBe("The Beatles - Help!");
  });

  it("strips flac extension", () => {
    expect(youtubeSearchQueryFromTrackName("Artist - Song.flac")).toBe("Artist - Song");
  });

  it("trims and collapses spaces", () => {
    expect(youtubeSearchQueryFromTrackName("  foo   bar  ")).toBe("foo bar");
  });
});

describe("isLikelyLocalMp3Channel", () => {
  it("accepts blob library with audio/mpeg", () => {
    const c: Channel = {
      id: "audio-lib-x",
      name: "song.mp3",
      url: "blob:http://localhost/x",
      libraryTrackId: "lib-1",
      libraryContentType: "audio/mpeg",
    };
    expect(isLikelyLocalMp3Channel(c)).toBe(true);
  });

  it("accepts blob library with audio/flac (same lyrics / YouTube flow as MP3)", () => {
    const c: Channel = {
      id: "audio-lib-y",
      name: "Album Track",
      url: "blob:http://localhost/y",
      libraryTrackId: "lib-2",
      libraryContentType: "audio/flac",
    };
    expect(isLikelyLocalMp3Channel(c)).toBe(true);
  });

  it("accepts audiobook-style m4b with audio/mp4", () => {
    const c: Channel = {
      id: "audio-lib-m4b",
      name: "Author - Book.m4b",
      url: "blob:http://localhost/z",
      libraryTrackId: "lib-m4b",
      libraryContentType: "audio/mp4",
    };
    expect(isLikelyLocalMp3Channel(c)).toBe(true);
  });

  it("rejects non-library", () => {
    const c: Channel = { id: "1", name: "x", url: "https://a/b" };
    expect(isLikelyLocalMp3Channel(c)).toBe(false);
  });
});
