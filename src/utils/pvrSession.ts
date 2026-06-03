import type { PvrTimerState } from "./pvrRecording";

const SHOW_SEL_KEY = "iptv-pvr-show-selection";

export interface PvrShowSelection {
  programmeStart: number;
  programmeStop: number;
  title: string;
}

export const PVR_SHOW_SELECTION_EVENT = "iptv-pvr-show-selection";

export interface PvrShowSelectionDetail {
  channelId: string;
  selection: PvrShowSelection | null;
}

export type PvrPendingStatus = "scheduled" | "recording";

export interface PvrPendingAction extends PvrTimerState {
  sessionId: string;
  pane: "L" | "R";
  sourceUrl: string;
  status: PvrPendingStatus;
  /** Scheduled or actual capture start. */
  startAtMs: number;
}

export const PVR_STOP_REQUEST_EVENT = "iptv-pvr-stop-request";
export const PVR_GOTO_CHANNEL_EVENT = "iptv-pvr-goto-channel";

export interface PvrStopRequestDetail {
  sessionId?: string;
  pane?: "L" | "R";
  channelId?: string;
}

export interface PvrGotoChannelDetail {
  channelId: string;
  pane?: "L" | "R";
}

function readShowSelMap(): Record<string, PvrShowSelection> {
  try {
    const raw = localStorage.getItem(SHOW_SEL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PvrShowSelection>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeShowSelMap(map: Record<string, PvrShowSelection>) {
  try {
    localStorage.setItem(SHOW_SEL_KEY, JSON.stringify(map));
  } catch {
    /* quota */
  }
}

function normalizeShowSelection(raw: unknown): PvrShowSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as PvrShowSelection;
  const programmeStart = Number(row.programmeStart);
  const programmeStop = Number(row.programmeStop);
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (!Number.isFinite(programmeStart) || !Number.isFinite(programmeStop) || programmeStop <= programmeStart) {
    return null;
  }
  if (!title) return null;
  return { programmeStart, programmeStop, title };
}

export function getPvrShowSelection(channelId: string): PvrShowSelection | null {
  const id = channelId.trim();
  if (!id) return null;
  return normalizeShowSelection(readShowSelMap()[id]);
}

export function setPvrShowSelection(channelId: string, selection: PvrShowSelection | null): void {
  const id = channelId.trim();
  if (!id) return;
  const normalized = normalizeShowSelection(selection);
  const selMap = readShowSelMap();
  if (normalized) selMap[id] = normalized;
  else delete selMap[id];
  writeShowSelMap(selMap);

  window.dispatchEvent(
    new CustomEvent<PvrShowSelectionDetail>(PVR_SHOW_SELECTION_EVENT, {
      detail: { channelId: id, selection: normalized },
    })
  );
}

/** True when the listing is still on air or starts in the future. */
export function isPvrShowSelectionRecordable(
  selection: PvrShowSelection | null,
  nowMs = Date.now()
): boolean {
  return !!selection && selection.programmeStop > nowMs + 15_000;
}

export function dispatchPvrStopRequest(detail: PvrStopRequestDetail) {
  window.dispatchEvent(
    new CustomEvent<PvrStopRequestDetail>(PVR_STOP_REQUEST_EVENT, { detail })
  );
}

export function dispatchPvrGotoChannel(channelId: string, pane?: "L" | "R") {
  window.dispatchEvent(
    new CustomEvent<PvrGotoChannelDetail>(PVR_GOTO_CHANNEL_EVENT, {
      detail: { channelId, pane },
    })
  );
}
