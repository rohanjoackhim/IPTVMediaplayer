import { describe, expect, it } from "vitest";
import { formatAudioTagsTooltip } from "./formatAudioTagsTooltip";

describe("formatAudioTagsTooltip", () => {
  it("formats fields as labeled lines", () => {
    const t = formatAudioTagsTooltip(
      [
        { label: "Artist", value: "Beatles" },
        { label: "Title", value: "Yesterday" },
      ],
      { fileName: "song.mp3" }
    );
    expect(t).toContain("File: song.mp3");
    expect(t).toContain("Artist: Beatles");
    expect(t).toContain("Title: Yesterday");
  });
});
