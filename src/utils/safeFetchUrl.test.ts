import { describe, expect, it } from "vitest";
import { assertSafeFetchUrl, isBlockedFetchHostname } from "./safeFetchUrl";

describe("safeFetchUrl", () => {
  it("blocks loopback and metadata hosts", () => {
    expect(isBlockedFetchHostname("127.0.0.1")).toBe(true);
    expect(isBlockedFetchHostname("localhost")).toBe(true);
    expect(isBlockedFetchHostname("169.254.169.254")).toBe(true);
    expect(isBlockedFetchHostname("metadata.google.internal")).toBe(true);
  });

  it("allows LAN IPTV hosts", () => {
    expect(isBlockedFetchHostname("192.168.1.50")).toBe(false);
    expect(isBlockedFetchHostname("10.0.0.12")).toBe(false);
  });

  it("rejects credentials in URLs", () => {
    expect(() => assertSafeFetchUrl("http://user:pass@example.com/stream.ts")).toThrow(/credentials/i);
  });
});
