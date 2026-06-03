export interface PvrTimerState {
  channelId: string;
  channelName: string;
  startedAtMs: number;
  stopAtMs: number;
  label: string;
}

export function formatPvrCountdown(msLeft: number): string {
  const sec = Math.max(0, Math.ceil(msLeft / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function pvrProgressPercent(startedAtMs: number, stopAtMs: number, nowMs = Date.now()): number {
  const total = stopAtMs - startedAtMs;
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, ((nowMs - startedAtMs) / total) * 100));
}

/** PVR jobs tied to an EPG listing (label starts with "Until "). */
export function isPvrShowBoundLabel(label: string): boolean {
  return /^Until\s+/i.test(label.trim());
}

export function buildPvrLabelFromShow(title?: string | null): string {
  const t = title?.trim();
  return t ? `Until ${t}` : "Until show ends";
}

export function buildPvrScheduleFromShow(
  programmeStartMs: number,
  programmeStopMs: number,
  programmeTitle?: string | null,
  nowMs = Date.now()
): { startAtMs: number; stopAtMs: number; label: string } | null {
  if (!Number.isFinite(programmeStartMs) || !Number.isFinite(programmeStopMs)) return null;
  if (programmeStopMs <= nowMs + 15_000) return null;
  const startAtMs = programmeStartMs > nowMs + 60_000 ? programmeStartMs : nowMs;
  return {
    startAtMs,
    stopAtMs: programmeStopMs,
    label: buildPvrLabelFromShow(programmeTitle),
  };
}

/** Wall-clock programme end; never shorten because capture started late. */
export function resolvePvrCaptureStopAt(
  session: { stopAtMs: number },
  captureStartedAtMs: number
): number {
  return Math.max(captureStartedAtMs + 60_000, session.stopAtMs);
}
