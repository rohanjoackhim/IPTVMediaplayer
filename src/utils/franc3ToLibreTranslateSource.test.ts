import { describe, expect, it } from "vitest";
import { libreTranslateSourceForFranc3 } from "./franc3ToLibreTranslateSource";

describe("libreTranslateSourceForFranc3", () => {
  it("maps zh to Libre code", () => {
    expect(libreTranslateSourceForFranc3("zho")).toBe("zh");
  });

  it("maps Hebrew-style iw to he for Libre", () => {
    expect(libreTranslateSourceForFranc3("heb")).toBe("he");
  });

  it("passes through Spanish", () => {
    expect(libreTranslateSourceForFranc3("spa")).toBe("es");
  });

  it("returns null for English / und", () => {
    expect(libreTranslateSourceForFranc3("eng")).toBeNull();
    expect(libreTranslateSourceForFranc3("und")).toBeNull();
  });
});
