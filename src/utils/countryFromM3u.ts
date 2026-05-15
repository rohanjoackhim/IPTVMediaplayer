/**
 * Derive a display country label from M3U metadata and common IPTV group-title patterns
 * (e.g. "US | Movies", "DE - Sport", "UK|Entertainment").
 */
export function normalizeCountryLabel(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  return t.length <= 48 ? t : t.slice(0, 45) + "…";
}

/** First segment before | · - – — if it looks like a country / region token. */
export function inferCountryFromGroupTitle(group: string | undefined): string {
  if (!group?.trim()) return "";
  const g = group.trim();
  const m = /^([A-Za-z][A-Za-z.\s]{1,31}?)\s*[\|·\u00B7\-–—]\s*/.exec(g);
  if (!m) return "";
  const seg = m[1].trim();
  if (seg.length < 2 || seg.length > 32) return "";
  if (/^(HD|FHD|UHD|4K|SD|VIP|LIVE|TV)$/i.test(seg)) return "";
  return normalizeCountryLabel(seg);
}
