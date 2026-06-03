import { describe, expect, it } from "vitest";
import { buildPvrOutputBasename, sanitizePvrFilenameSegment } from "./pvrRecordingFilename";

describe("pvrRecordingFilename", () => {
  it("sanitizes unsafe characters", () => {
    expect(sanitizePvrFilenameSegment('MEX: CNN / "News"')).toBe("MEX_CNN_News");
  });

  it("builds channel_event_from_to basename", () => {
    const start = new Date(2026, 4, 20, 19, 59, 0).getTime();
    const stop = new Date(2026, 4, 20, 20, 0, 0).getTime();
    expect(
      buildPvrOutputBasename({
        channelName: "MEX: CNN EN ESPAÑOL",
        label: "Until Erin Burnett OutFront",
        startAtMs: start,
        stopAtMs: stop,
      })
    ).toMatch(/^MEX_CNN_EN_ESPAÑOL_Until_Erin_Burnett_OutFront_\d+-\d+(AM|PM)_to_\d+-\d+(AM|PM)$/);
  });
});
