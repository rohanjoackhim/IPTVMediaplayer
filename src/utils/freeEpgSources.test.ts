import { describe, expect, it } from "vitest";
import {
  detectEpgCountriesFromChannels,
  epgGuideUrlsForChannel,
  FREE_GLOBAL_EPG_URL,
} from "./freeEpgSources";

describe("detectEpgCountriesFromChannels", () => {
  it("detects country from tvg-id suffix and group", () => {
    const codes = detectEpgCountriesFromChannels([
      { name: "ARD", tvgId: "ARD.de", group: "DE | General" },
      { name: "TF1", country: "FR" },
      { name: "CNN", tvgId: "CNN.us" },
    ]);
    expect(codes).toContain("de");
    expect(codes).toContain("fr");
  });

});

describe("epgGuideUrlsForChannel", () => {
  it("includes global guide for Canadian channels without Open-EPG file", () => {
    const urls = epgGuideUrlsForChannel({ name: "CA.TSN 1", tvgId: "TSN1.ca" });
    expect(urls[urls.length - 1]).toBe(FREE_GLOBAL_EPG_URL);
  });

  it("prefers regional Open-EPG before global", () => {
    const urls = epgGuideUrlsForChannel({ name: "ARD", tvgId: "ARD.de", country: "DE" });
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls[urls.length - 1]).toBe(FREE_GLOBAL_EPG_URL);
    expect(urls[0]).toContain("germany");
  });
});
