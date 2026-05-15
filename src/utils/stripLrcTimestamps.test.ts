import { describe, expect, it } from "vitest";
import { stripLrcTimestamps } from "./stripLrcTimestamps";

describe("stripLrcTimestamps", () => {
  it("removes leading timestamps per line", () => {
    const s = "[00:12.34] First line\n[01:00.00] Second line";
    expect(stripLrcTimestamps(s)).toBe("First line\nSecond line");
  });
});
