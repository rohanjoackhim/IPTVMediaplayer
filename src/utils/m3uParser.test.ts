import { describe, expect, it } from "vitest";
import { normalizeM3uText, parseM3U } from "./m3uParser";

describe("normalizeM3uText", () => {
  it("strips UTF-8 BOM", () => {
    expect(normalizeM3uText("\uFEFF#EXTM3U\n")).toBe("#EXTM3U");
  });
});

describe("parseM3U", () => {
  it("reads tvg-id on channels", () => {
    const text = `#EXTM3U
#EXTINF:-1 tvg-id="bbc.one" tvg-logo="x" group-title="UK",BBC One
http://stream.example/bbc`;
    const { channels } = parseM3U(text);
    expect(channels[0]?.tvgId).toBe("bbc.one");
  });
});
