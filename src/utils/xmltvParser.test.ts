import { describe, expect, it } from "vitest";
import { parseXmltvTimestamp } from "./xmltvParser";
import { resolveEpgChannelId } from "./epgService";
import type { Channel } from "../types";
import type { ParsedXmltv } from "./xmltvParser";

describe("parseXmltvTimestamp", () => {
  it("parses XMLTV datetime with timezone", () => {
    const ms = parseXmltvTimestamp("20240520120000 +0000");
    expect(ms).not.toBeNull();
    expect(new Date(ms!).getUTCHours()).toBe(12);
  });

  it("parses XMLTV datetime without offset as system-local wall clock", () => {
    const ms = parseXmltvTimestamp("20240520173000");
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect(d.getHours()).toBe(17);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("resolveEpgChannelId", () => {
  it("matches by tvg-id then display name", () => {
    const data: ParsedXmltv = {
      channelNames: new Map([["bbc.one", ["BBC One"]]]),
      programmes: [],
    };
    const byId: Channel = { id: "x", name: "Other", url: "http://x", tvgId: "bbc.one" };
    expect(resolveEpgChannelId(byId, data)).toBe("bbc.one");
    const byName: Channel = { id: "y", name: "BBC One HD", url: "http://y" };
    expect(resolveEpgChannelId(byName, data)).toBe("bbc.one");
  });

  it("matches CA.TSN style names against tsn display names", () => {
    const data: ParsedXmltv = {
      channelNames: new Map([["tsn1.ca", ["TSN 1", "CA TSN 1"]]]),
      programmes: [],
    };
    const ch: Channel = { id: "z", name: "CA.TSN 1", url: "http://z", tvgId: "TSN1.ca" };
    expect(resolveEpgChannelId(ch, data)).toBe("tsn1.ca");
  });
});
