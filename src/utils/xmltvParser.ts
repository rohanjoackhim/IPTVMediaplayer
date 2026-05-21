/** One programme row from XMLTV. Times are UTC epoch ms. */
export interface EpgProgramme {
  channelId: string;
  start: number;
  stop: number;
  title: string;
  description?: string;
}

export interface ParsedXmltv {
  /** XMLTV `<channel id>` → display names */
  channelNames: Map<string, string[]>;
  programmes: EpgProgramme[];
}

/** Skip full DOM parse in the renderer above this size (bytes). */
export const MAX_RENDERER_XMLTV_BYTES = 1_200_000;

function tzToIsoOffset(tz: string): string {
  const sign = tz[0] === "-" ? "-" : "+";
  const hh = tz.slice(1, 3);
  const mm = tz.slice(3, 5);
  return `${sign}${hh}:${mm}`;
}

/** Parse XMLTV `YYYYMMDDHHmmss [±HHMM]`. */
export function parseXmltvTimestamp(raw: string): number | null {
  const s = raw.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tz] = m;
  if (tz) {
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${tzToIsoOffset(tz)}`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  // No offset: wall clock in the viewer's system time zone (common IPTV guides).
  const local = new Date(
    parseInt(y!, 10),
    parseInt(mo!, 10) - 1,
    parseInt(d!, 10),
    parseInt(h!, 10),
    parseInt(mi!, 10),
    parseInt(se!, 10)
  );
  const ms = local.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function textContent(el: Element | null, tag: string): string {
  const node = el?.getElementsByTagName(tag)[0];
  return node?.textContent?.trim() ?? "";
}

/** Fast channel index only — safe for multi‑MB XML on a background tick. */
export function parseXmltvChannelIndex(text: string): ParsedXmltv {
  const channelNames = new Map<string, string[]>();
  const chRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
  let m: RegExpExecArray | null;
  while ((m = chRe.exec(text)) !== null) {
    const id = m[1]?.trim();
    if (!id) continue;
    const block = m[2] ?? "";
    const names: string[] = [];
    const dnRe = /<display-name[^>]*>([^<]*)<\/display-name>/gi;
    let dn: RegExpExecArray | null;
    while ((dn = dnRe.exec(block)) !== null) {
      const t = dn[1]?.trim();
      if (t) names.push(t);
    }
    channelNames.set(id, names.length ? names : [id]);
  }
  return { channelNames, programmes: [] };
}

/** Extract one channel’s programmes from XML text without DOM (time window filter). */
export function extractProgrammesForChannelFromXml(
  text: string,
  channelId: string,
  fromMs: number,
  toMs: number
): EpgProgramme[] {
  const programmes: EpgProgramme[] = [];
  const idNeedle = `channel="${channelId}"`;
  const progRe = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
  let m: RegExpExecArray | null;
  while ((m = progRe.exec(text)) !== null) {
    const attrs = m[1] ?? "";
    if (!attrs.includes(idNeedle)) continue;
    const startM = /start="([^"]+)"/.exec(attrs);
    const stopM = /stop="([^"]+)"/.exec(attrs);
    if (!startM || !stopM) continue;
    const start = parseXmltvTimestamp(startM[1]!);
    const stop = parseXmltvTimestamp(stopM[1]!);
    if (start == null || stop == null || stop <= start) continue;
    if (stop <= fromMs || start >= toMs) continue;
    const body = m[2] ?? "";
    const titleM = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
    const descM = /<desc[^>]*>([^<]*)<\/desc>/i.exec(body);
    programmes.push({
      channelId,
      start,
      stop,
      title: (titleM?.[1] ?? "Programme").trim() || "Programme",
      description: descM?.[1]?.trim() || undefined,
    });
  }
  programmes.sort((a, b) => a.start - b.start);
  return programmes;
}

export function parseXmltv(text: string): ParsedXmltv {
  if (text.length > MAX_RENDERER_XMLTV_BYTES) {
    return parseXmltvChannelIndex(text);
  }

  const channelNames = new Map<string, string[]>();
  const programmes: EpgProgramme[] = [];

  const doc = new DOMParser().parseFromString(text, "text/xml");
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) {
    throw new Error("Invalid XMLTV document.");
  }

  for (const ch of doc.getElementsByTagName("channel")) {
    const id = ch.getAttribute("id")?.trim();
    if (!id) continue;
    const names: string[] = [];
    for (const dn of ch.getElementsByTagName("display-name")) {
      const t = dn.textContent?.trim();
      if (t) names.push(t);
    }
    channelNames.set(id, names.length ? names : [id]);
  }

  for (const prog of doc.getElementsByTagName("programme")) {
    const channelId = prog.getAttribute("channel")?.trim();
    const startRaw = prog.getAttribute("start");
    const stopRaw = prog.getAttribute("stop");
    if (!channelId || !startRaw || !stopRaw) continue;
    const start = parseXmltvTimestamp(startRaw);
    const stop = parseXmltvTimestamp(stopRaw);
    if (start == null || stop == null || stop <= start) continue;
    const title = textContent(prog, "title") || "Programme";
    const description = textContent(prog, "desc") || textContent(prog, "description") || undefined;
    programmes.push({ channelId, start, stop, title, description });
  }

  programmes.sort((a, b) => a.start - b.start);
  return { channelNames, programmes };
}
