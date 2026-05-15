import { describe, expect, it } from "vitest";
import {
  alignTranslatedLines,
  lyricTranslationProviderHint,
  parseMyMemoryTranslation,
} from "./translateLyricsLines";

describe("parseMyMemoryTranslation", () => {
  it("returns translated text for a normal payload", () => {
    expect(
      parseMyMemoryTranslation({
        responseData: { translatedText: "Hello world" },
      })
    ).toBe("Hello world");
  });

  it("rejects MyMemory quota warning embedded in translatedText", () => {
    expect(() =>
      parseMyMemoryTranslation({
        responseData: {
          translatedText: "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY",
        },
      })
    ).toThrow(/MyMemory free quota exhausted/);
  });
});

describe("lyricTranslationProviderHint", () => {
  it("names LLM backend", () => {
    expect(lyricTranslationProviderHint(["lyrics_chat"])).toContain("LLM (OpenAI-compatible)");
  });

  it("marks free chain and nudges LLM API key", () => {
    const h = lyricTranslationProviderHint(["google_gtx", "libretranslate"]);
    expect(h).toContain("free");
    expect(h).toMatch(/Google \(public\)/);
    expect(h).toMatch(/LibreTranslate/);
    expect(h).toMatch(/add an LLM API key in Settings/);
  });

  it("shows LLM with free backends on some batches", () => {
    expect(lyricTranslationProviderHint(["lyrics_chat", "google_gtx"])).toMatch(/LLM/);
    expect(lyricTranslationProviderHint(["lyrics_chat", "google_gtx"])).toMatch(/some batches/);
  });

  it("dedupes repeated providers", () => {
    expect(lyricTranslationProviderHint(["mymemory", "mymemory", "mymemory"])).toMatch(/^Translation: MyMemory/);
  });
});

describe("alignTranslatedLines", () => {
  it("aligns equal line counts", () => {
    expect(alignTranslatedLines(["a", "b"], "x\ny")).toEqual(["x", "y"]);
  });
});
