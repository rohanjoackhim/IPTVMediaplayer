import { describe, expect, it } from "vitest";
import { identityFromFilenameLabel, pickBestLyricsIdentity, tokenSimilarityForLyrics } from "./lyricsTrackIdentity";

describe("lyricsTrackIdentity", () => {
  it("prefers filename when tags disagree with file name", () => {
    const tagMeta = {
      artist: "Unknown",
      title: "Carei Que Errs Mir",
      album: "",
      source: "tags" as const,
    };
    const fileMeta = identityFromFilenameLabel("Yuri - Angelitos de Colores.mp3");
    const picked = pickBestLyricsIdentity(tagMeta, fileMeta, fileMeta);
    expect(picked.artist).toBe("Yuri");
    expect(picked.title).toContain("Angelitos");
    expect(picked.source).toBe("filename");
  });

  it("keeps tags when they match filename", () => {
    const fileMeta = identityFromFilenameLabel("Yuri - Angelitos de Colores.mp3");
    const tagMeta = { ...fileMeta, source: "tags" as const };
    const picked = pickBestLyricsIdentity(tagMeta, fileMeta, fileMeta);
    expect(picked.source).toBe("tags");
    expect(tokenSimilarityForLyrics(picked.title, "Angelitos de Colores")).toBeGreaterThan(0.7);
  });
});
