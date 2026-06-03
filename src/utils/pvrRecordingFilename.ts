import type { PvrManagedSession } from "./pvrRecordingManager";

/** Safe single segment for a recording file name (no path separators). */
export function sanitizePvrFilenameSegment(raw: string, maxLen = 56): string {
  const s = raw
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^_|_$/g, "");
  if (!s) return "unknown";
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}_` : s;
}

/** Clock label for filenames, e.g. 7-59PM (no colons — Windows-safe). */
export function formatPvrFilenameClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}-${String(m).padStart(2, "0")}${ap}`;
}

/** channel_event_from_to — extension added by the recorder. */
export function buildPvrOutputBasename(session: Pick<PvrManagedSession, "channelName" | "label" | "startAtMs" | "stopAtMs">): string {
  const channel = sanitizePvrFilenameSegment(session.channelName);
  const event = sanitizePvrFilenameSegment(session.label);
  const from = formatPvrFilenameClock(session.startAtMs);
  const to = formatPvrFilenameClock(session.stopAtMs);
  return `${channel}_${event}_${from}_to_${to}`;
}
