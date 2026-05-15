import { describe, expect, it } from "vitest";
import { formatLlmUsageLine } from "./lyricsLlmEndpointLabel";

describe("formatLlmUsageLine", () => {
  it("includes purpose and endpoint", () => {
    expect(formatLlmUsageLine("song meaning", "deepseek-chat", "api.deepseek.com")).toBe(
      "song meaning: deepseek-chat @ api.deepseek.com"
    );
  });
});
