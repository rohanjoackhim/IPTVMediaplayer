const BLOCKED_FETCH_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
]);

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/** Block loopback, link-local, and cloud metadata hosts. RFC1918 LAN IPs are allowed for IPTV. */
export function isBlockedFetchHostname(hostname: string): boolean {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (BLOCKED_FETCH_HOSTNAMES.has(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;

  const v4 = parseIpv4(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export function assertSafeFetchUrl(raw: string, label = "URL"): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) ${label} is supported.`);
  }
  if (isBlockedFetchHostname(u.hostname)) {
    throw new Error("That host is not allowed.");
  }
  if (u.username || u.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  return u.toString();
}
