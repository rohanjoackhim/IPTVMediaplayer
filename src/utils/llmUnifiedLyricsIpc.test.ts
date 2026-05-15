import { describe, expect, it } from "vitest";
import { coerceLlmUnifiedIpcResult } from "./llmUnifiedLyricsIpc";

describe("coerceLlmUnifiedIpcResult", () => {
  it("accepts a valid ok payload", () => {
    const r = coerceLlmUnifiedIpcResult({
      ok: true,
      detectedFranc3: "spa",
      lrclibTrack: "Artist — Song",
      headline: "LLM: Artist — Song · find + translate…",
      pairs: [
        { orig: "Hola", en: "Hello" },
        { orig: "Mundo", en: "World" },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.pairs).toHaveLength(2);
    expect(r!.pairs[0].en).toBe("Hello");
    expect(r!.detectedFranc3).toBe("spa");
  });

  it("returns null when ok is false", () => {
    expect(coerceLlmUnifiedIpcResult({ ok: false, pairs: [] })).toBeNull();
  });

  it("defaults invalid detectedFranc3 to und", () => {
    const r = coerceLlmUnifiedIpcResult({
      ok: true,
      detectedFranc3: "es",
      pairs: [{ orig: "a", en: "b" }],
    });
    expect(r!.detectedFranc3).toBe("und");
  });

  it("appends LLM host and model when present", () => {
    const r = coerceLlmUnifiedIpcResult({
      ok: true,
      pairs: [{ orig: "a", en: "b" }],
      headline: "LLM: Test · find + translate",
      llmModel: "deepseek-chat",
      llmHost: "api.deepseek.com",
    });
    expect(r!.headline).toContain("deepseek-chat @ api.deepseek.com");
  });

  it("fills missing en from orig", () => {
    const r = coerceLlmUnifiedIpcResult({
      ok: true,
      pairs: [{ orig: "solo" }],
    });
    expect(r!.pairs[0].en).toBe("solo");
  });
});
