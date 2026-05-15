import { describe, expect, it } from "vitest";
import { parseGoogleGtxTranslate } from "./parseGoogleGtxTranslate";

describe("parseGoogleGtxTranslate", () => {
  it("concatenates fragments from a real-style GTX payload", () => {
    const raw: unknown = JSON.parse(
      '[[["Hello world","Hola mundo",null,null,3,null,null,[[]],[[["d0311b314139639afa8d9993705f8a28","es_en_2023q1.md"]]]]],null,"es",null,null,null,null,[]]'
    );
    expect(parseGoogleGtxTranslate(raw)).toBe("Hello world");
  });

  it("joins multiple GTX sentence tuples (fragment order)", () => {
    const raw: unknown = [
      [
        ["A", "a", null, null, 0],
        ["B", "b", null, null, 0],
      ],
      null,
      "es",
    ];
    expect(parseGoogleGtxTranslate(raw)).toBe("AB");
  });
});
