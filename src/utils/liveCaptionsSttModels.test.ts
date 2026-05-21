import { describe, expect, it } from "vitest";
import { parseLiveCaptionsSttModel } from "./liveCaptionsSttModels";

describe("parseLiveCaptionsSttModel", () => {
  it("accepts known keys", () => {
    expect(parseLiveCaptionsSttModel("tiny")).toBe("tiny");
    expect(parseLiveCaptionsSttModel("base")).toBe("base");
    expect(parseLiveCaptionsSttModel("small")).toBe("small");
  });

  it("defaults invalid values to tiny", () => {
    expect(parseLiveCaptionsSttModel("large")).toBe("tiny");
    expect(parseLiveCaptionsSttModel(null)).toBe("tiny");
  });
});
