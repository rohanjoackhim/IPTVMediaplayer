import { describe, expect, it } from "vitest";
import { guessArtistAndTrackFromFilename } from "./artistTitleFromFilename";

describe("guessArtistAndTrackFromFilename", () => {
  it("splits Artist - Title", () => {
    expect(guessArtistAndTrackFromFilename("The Beatles - Help.mp3")).toEqual({
      artist: "The Beatles",
      track: "Help",
    });
  });

  it("parses feat. before dash title", () => {
    expect(guessArtistAndTrackFromFilename("A ft. B - Song.mp3")).toEqual({
      artist: "A B",
      track: "Song",
    });
  });

  it("returns empty artist when no separator", () => {
    expect(guessArtistAndTrackFromFilename("Helpless.mp3")).toEqual({ artist: "", track: "Helpless" });
  });
});
