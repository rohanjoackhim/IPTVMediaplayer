import { describe, expect, it } from "vitest";
import {
  buildPvrLabelFromShow,
  buildPvrScheduleFromShow,
  formatPvrCountdown,
  isPvrShowBoundLabel,
  pvrProgressPercent,
  resolvePvrCaptureStopAt,
} from "./pvrRecording";

describe("pvrRecording", () => {
  it("formats countdown", () => {
    expect(formatPvrCountdown(90_000)).toBe("1:30");
    expect(formatPvrCountdown(3_661_000)).toBe("1:01:01");
  });

  it("builds schedule from programme times", () => {
    const built = buildPvrScheduleFromShow(1_000_000, 1_600_000, "Tennis", 1_000_000);
    expect(built?.startAtMs).toBe(1_000_000);
    expect(built?.stopAtMs).toBe(1_600_000);
    expect(built?.label).toBe("Until Tennis");
  });

  it("starts now when programme already on air", () => {
    const built = buildPvrScheduleFromShow(900_000, 1_600_000, null, 1_000_000);
    expect(built?.startAtMs).toBe(1_000_000);
    expect(built?.label).toBe("Until show ends");
  });

  it("builds show label", () => {
    expect(buildPvrLabelFromShow("News")).toBe("Until News");
    expect(isPvrShowBoundLabel("Until News")).toBe(true);
  });

  it("computes progress percent", () => {
    expect(pvrProgressPercent(0, 100, 50)).toBe(50);
    expect(pvrProgressPercent(0, 100, 150)).toBe(100);
  });

  it("keeps programme end at capture start", () => {
    const end = 1_000_000 + 30 * 60_000;
    expect(resolvePvrCaptureStopAt({ stopAtMs: end }, 1_000_000 + 60_000)).toBe(end);
  });
});
