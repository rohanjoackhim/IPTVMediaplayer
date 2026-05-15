import { describe, expect, it } from "vitest";
import { buildLrclibSearchPlans, normalizeLyricsTitleSource } from "./lyricsQueryVariants";

describe("normalizeLyricsTitleSource", () => {
  it("strips bracket tags and leading index", () => {
    expect(normalizeLyricsTitleSource("[2024] 03 - Hello World (official).mp3")).toContain("Hello World");
  });
});

describe("buildLrclibSearchPlans", () => {
  it("returns multiple distinct plans", () => {
    const p = buildLrclibSearchPlans("Artist Name - Track Title.mp3");
    expect(p.length).toBeGreaterThan(2);
    expect(p.some((x) => x.mode === "trackArtist")).toBe(true);
  });

  it("prioritizes file tag artist and title", () => {
    const p = buildLrclibSearchPlans("wrong-file-name.mp3", {
      artist: "Real Artist",
      title: "Real Song",
    });
    const firstTa = p.find((x) => x.mode === "trackArtist");
    expect(firstTa?.mode).toBe("trackArtist");
    if (firstTa?.mode === "trackArtist") {
      expect(firstTa.artistName.toLowerCase()).toContain("real artist");
      expect(firstTa.trackName.toLowerCase()).toContain("real song");
    }
  });
});
