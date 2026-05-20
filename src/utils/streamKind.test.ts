import { describe, expect, it } from "vitest";
import {
  isLikelyMpegTsOverHttp,
  isLikelyXtreamVodPath,
  isMatroskaUrl,
  needsDesktopFfmpegPlayback,
} from "./streamKind";

describe("streamKind", () => {
  it("detects matroska paths with query strings and trailing slashes", () => {
    expect(isMatroskaUrl("http://host/movie/u/p/1.mkv?token=abc")).toBe(true);
    expect(isMatroskaUrl("http://host/movie/u/p/1.mkv/")).toBe(true);
  });

  it("treats Xtream VOD /movie/ URLs as FFmpeg remux candidates", () => {
    const vod = "http://annexwcop.top:8080/movie/user/pass/54715";
    expect(isLikelyXtreamVodPath(vod)).toBe(true);
    expect(needsDesktopFfmpegPlayback(vod)).toBe(true);
    expect(isLikelyMpegTsOverHttp(vod)).toBe(false);
  });

  it("does not classify VOD .ts links as live MPEG-TS", () => {
    const vodTs = "http://host:8080/movie/user/pass/54715.ts";
    expect(isLikelyMpegTsOverHttp(vodTs)).toBe(false);
    expect(needsDesktopFfmpegPlayback(vodTs)).toBe(true);
  });

  it("still treats /live/ .ts as MPEG-TS", () => {
    const live = "http://host:8080/live/user/pass/12345.ts";
    expect(isLikelyMpegTsOverHttp(live)).toBe(true);
    expect(needsDesktopFfmpegPlayback(live)).toBe(false);
  });
});
