import { describe, expect, it } from "vitest";
import { buildLrclibSearchPlans } from "./lyricsQueryVariants";

describe("buildLrclibSearchPlans", () => {
  it("prioritizes Google-style Artist - Title query from file tags", () => {
    const plans = buildLrclibSearchPlans("01 Yuri - Angelitos de Colores.mp3", {
      artist: "Yuri",
      title: "Angelitos de Colores",
    });
    const qPlans = plans.filter((p) => p.mode === "q").map((p) => (p.mode === "q" ? p.q : ""));
    expect(qPlans[0]).toBe("Yuri - Angelitos de Colores");
    expect(plans[0]).toEqual({
      mode: "trackArtist",
      trackName: "Angelitos de Colores",
      artistName: "Yuri",
    });
  });
});
