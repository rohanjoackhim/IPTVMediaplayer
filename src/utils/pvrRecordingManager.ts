import type { Channel } from "../types";
import type { PvrTimerState } from "./pvrRecording";
import { resolvePvrCaptureStopAt } from "./pvrRecording";
import { buildPvrOutputBasename } from "./pvrRecordingFilename";
import { recordFileSuffixAndTapType } from "./recordableStream";

const SCHEDULED_KEY = "iptv-pvr-scheduled-sessions";
const HISTORY_KEY = "iptv-pvr-history";
const MAX_HISTORY_ENTRIES = 80;

export type PvrSessionStatus = "scheduled" | "recording" | "completed" | "cancelled";

export interface PvrManagedSession {
  sessionId: string;
  pane: "L" | "R";
  channelId: string;
  channelName: string;
  sourceUrl: string;
  status: PvrSessionStatus;
  /** Wall clock when capture should begin (may be in the future). */
  startAtMs: number;
  stopAtMs: number;
  label: string;
  /** When status is recording — actual capture start. */
  startedAtMs: number;
  recordId?: string;
  filePath?: string;
  recordingCompact: boolean;
  completedAtMs?: number;
}

function normalizeManagedSession(raw: unknown): PvrManagedSession | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as PvrManagedSession;
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
  const channelId = typeof row.channelId === "string" ? row.channelId.trim() : "";
  const channelName = typeof row.channelName === "string" ? row.channelName.trim() : "Channel";
  const sourceUrl = typeof row.sourceUrl === "string" ? row.sourceUrl.trim() : "";
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const startAtMs = Number(row.startAtMs);
  const stopAtMs = Number(row.stopAtMs);
  const startedAtMs = Number(row.startedAtMs);
  if (!sessionId || !channelId || !Number.isFinite(startAtMs) || !Number.isFinite(stopAtMs)) return null;
  const status = row.status;
  if (status !== "scheduled" && status !== "recording" && status !== "completed" && status !== "cancelled") {
    return null;
  }
  return {
    sessionId,
    pane: row.pane === "R" ? "R" : "L",
    channelId,
    channelName: channelName || "Channel",
    sourceUrl,
    status,
    startAtMs,
    stopAtMs,
    label: label || "PVR",
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : startAtMs,
    recordId: typeof row.recordId === "string" ? row.recordId : undefined,
    filePath: typeof row.filePath === "string" ? row.filePath.trim() : undefined,
    recordingCompact: row.recordingCompact === true,
    completedAtMs: Number.isFinite(Number(row.completedAtMs)) ? Number(row.completedAtMs) : undefined,
  };
}

export interface PvrStartRequest {
  pane: "L" | "R";
  channel: Channel;
  stopAtMs: number;
  label: string;
  startAtMs?: number;
  recordingCompact: boolean;
}

export function newPvrSessionId(): string {
  return `pvr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function pvrSessionToTimer(session: PvrManagedSession): PvrTimerState {
  return {
    channelId: session.channelId,
    channelName: session.channelName,
    startedAtMs: session.status === "recording" ? session.startedAtMs : session.startAtMs,
    stopAtMs: session.stopAtMs,
    label: session.label,
  };
}

export function loadPersistedScheduledPvrSessions(): PvrManagedSession[] {
  try {
    const raw = localStorage.getItem(SCHEDULED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed
      .map((row) => normalizeManagedSession(row))
      .filter((s): s is PvrManagedSession => !!s && s.status === "scheduled" && s.stopAtMs > now + 5_000);
  } catch {
    return [];
  }
}

export function loadPvrHistory(): PvrManagedSession[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    const rows = parsed
      .map((row) => normalizeManagedSession(row))
      .filter((s): s is PvrManagedSession => !!s);
    const completed = rows.filter((s) => s.status === "completed");
    if (completed.length !== rows.length) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(completed.slice(0, MAX_HISTORY_ENTRIES)));
      } catch {
        /* quota */
      }
    }
    return completed.sort((a, b) => (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0));
  } catch {
    return [];
  }
}

export function removePvrHistoryEntry(sessionId: string): void {
  const id = sessionId.trim();
  if (!id) return;
  const next = loadPvrHistory().filter((h) => h.sessionId !== id);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}

export function appendPvrHistory(entry: PvrManagedSession): void {
  const normalized = normalizeManagedSession(entry);
  if (!normalized || normalized.status !== "completed") return;
  const prev = loadPvrHistory().filter((h) => h.sessionId !== normalized.sessionId);
  const next = [{ ...normalized, completedAtMs: normalized.completedAtMs ?? Date.now() }, ...prev].slice(
    0,
    MAX_HISTORY_ENTRIES
  );
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}

export function clearPvrHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* noop */
  }
}

export function persistScheduledPvrSessions(sessions: PvrManagedSession[]): void {
  try {
    const scheduled = sessions.filter((s) => s.status === "scheduled");
    localStorage.setItem(SCHEDULED_KEY, JSON.stringify(scheduled));
  } catch {
    /* quota */
  }
}

export function findPvrSessionForChannel(
  sessions: PvrManagedSession[],
  channelId: string
): PvrManagedSession | null {
  const id = channelId.trim();
  if (!id) return null;
  return sessions.find((s) => s.channelId === id) ?? null;
}

export function shouldSchedulePvrStart(startAtMs: number, nowMs = Date.now()): boolean {
  return startAtMs > nowMs + 5_000;
}

export async function startElectronStreamRecord(
  channel: Channel,
  outDir: string,
  recordingCompact: boolean,
  outputBasename?: string,
  opts?: { keepAlive?: boolean; recordUntilMs?: number }
): Promise<{ id: string; filePath: string }> {
  const url = channel.url?.trim();
  if (!url) throw new Error("Channel has no stream URL.");
  const hint = recordFileSuffixAndTapType(url, channel.id);
  const out = await window.iptv!.startStreamRecord({
    url,
    outDir,
    outputBasename: outputBasename?.trim() || undefined,
    filenameExt: hint.filenameExt,
    tapContentType: hint.tapContentType,
    recordMode: hint.recordMode,
    recordingCompact,
    keepAlive: opts?.keepAlive === true,
    recordUntilMs: opts?.recordUntilMs,
  });
  return { id: out.id, filePath: out.filePath };
}

export async function startElectronPvrRecord(
  session: PvrManagedSession,
  channel: Channel,
  outDir: string,
  captureStartedAtMs = Date.now()
): Promise<{ id: string; filePath: string; recordUntilMs: number }> {
  const recordUntilMs = resolvePvrCaptureStopAt(session, captureStartedAtMs);
  const out = await startElectronStreamRecord(
    channel,
    outDir,
    session.recordingCompact,
    buildPvrOutputBasename({ ...session, stopAtMs: recordUntilMs }),
    { keepAlive: true, recordUntilMs }
  );
  return { ...out, recordUntilMs };
}
