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

  it("adds title-only queries when artist tag is missing", () => {
    const p = buildLrclibSearchPlans("misc.mp3", { artist: "", title: "Angelitos de Colores" });
    const qPlans = p.filter((x) => x.mode === "q").map((x) => (x.mode === "q" ? x.q : ""));
    expect(qPlans.some((q) => q.includes("Angelitos de Colores"))).toBe(true);
  });

  it("merges plans from multiple metadata variants", () => {
    const p = buildLrclibSearchPlans("file.mp3", [
      { artist: "Yuri", title: "Angelitos de Colores" },
      { artist: "Wrong Tag", title: "Angelitos de Colores" },
    ]);
    expect(p.length).toBeGreaterThan(4);
    expect(p.some((x) => x.mode === "trackArtist" && x.artistName === "Yuri")).toBe(true);
  });
});
