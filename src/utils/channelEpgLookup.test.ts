import { describe, expect, it } from "vitest";
import { parseLlmEpgProgrammes } from "./channelEpgLookup";

describe("parseLlmEpgProgrammes", () => {
  it("parses LLM JSON into programme rows", () => {
    const raw = `{"programmes":[{"title":"News","start":"18:00","stop":"19:00"}],"disclaimer":"estimate"}`;
    const rows = parseLlmEpgProgrammes(raw, "test.ch");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("News");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = '```json\n{"programmes":[{"title":"Sports","start":"20:00","stop":"21:30"}]}\n```';
    const rows = parseLlmEpgProgrammes(raw, "tsn");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Sports");
  });
});
