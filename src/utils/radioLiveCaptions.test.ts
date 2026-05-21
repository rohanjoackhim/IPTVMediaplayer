import { describe, expect, it } from "vitest";
import {
  collapseRepeatedCaptionWords,
  mapRadioTranslationsToSegments,
  mergeRadioCaptionUtterance,
  prepareRadioCaptionLinesForTranslation,
} from "./radioLiveCaptions";

describe("collapseRepeatedCaptionWords", () => {
  it("collapses consecutive duplicate words", () => {
    expect(collapseRepeatedCaptionWords("the the the news")).toBe("the news");
  });

  it("limits dominant word spam", () => {
    const out = collapseRepeatedCaptionWords("yeah yeah yeah yeah yeah yeah yeah yeah");
    expect(out.split(/\s+/).filter((w) => w.toLowerCase() === "yeah").length).toBeLessThanOrEqual(2);
  });

  it("collapses repeated short phrases", () => {
    expect(collapseRepeatedCaptionWords("I think I think I think I think today")).toBe("I think today");
  });
});

describe("mergeRadioCaptionUtterance", () => {
  it("extends the previous line when the next chunk shares words", () => {
    expect(mergeRadioCaptionUtterance("hello world", "world today")).toEqual({
      text: "hello world today",
      replaceLast: true,
    });
  });

  it("does not shrink when whisper returns a shorter prefix", () => {
    expect(mergeRadioCaptionUtterance("hello world today", "hello world")).toEqual({
      text: "hello world today",
      replaceLast: true,
    });
  });

  it("starts a new line when utterances do not overlap", () => {
    expect(mergeRadioCaptionUtterance("good morning", "goodbye")).toEqual({
      text: "goodbye",
      replaceLast: false,
    });
  });
});

describe("prepareRadioCaptionLinesForTranslation", () => {
  it("skips consecutive duplicate lines", () => {
    const { texts, lineToSegmentIndex } = prepareRadioCaptionLinesForTranslation([
      "hello",
      "hello",
      "world",
    ]);
    expect(texts).toEqual(["hello", "world"]);
    expect(lineToSegmentIndex).toEqual([0, 2]);
  });
});

describe("mapRadioTranslationsToSegments", () => {
  it("fills duplicate segment indices from prior translation", () => {
    const mapped = mapRadioTranslationsToSegments(
      3,
      [0, 2],
      ["hola", "mundo"],
      ["hello", "hello", "world"]
    );
    expect(mapped).toEqual(["hola", "hola", "mundo"]);
  });
});
