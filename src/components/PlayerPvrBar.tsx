import { useCallback, useEffect, useMemo, useState } from "react";
import type { Channel } from "../types";
import { getChannelEpgCache, CHANNEL_EPG_UPDATED_EVENT, type ChannelEpgUpdatedDetail } from "../utils/channelEpgSession";
import { currentProgramme, formatEpgClock, formatEpgTimeRange } from "../utils/epgService";
import type { PvrManagedSession } from "../utils/pvrRecordingManager";
import {
  buildPvrScheduleFromShow,
  formatPvrCountdown,
  pvrProgressPercent,
} from "../utils/pvrRecording";
import {
  getPvrShowSelection,
  isPvrShowSelectionRecordable,
  PVR_SHOW_SELECTION_EVENT,
  type PvrShowSelection,
  type PvrShowSelectionDetail,
} from "../utils/pvrSession";
import "./PlayerPvrBar.css";

export interface PlayerPvrBarProps {
  channel: Channel;
  canRecord: boolean;
  recordBusy: boolean;
  recordingCompact: boolean;
  onRecordingCompactChange: (compact: boolean) => void;
  channelPvrSession: PvrManagedSession | null;
  recordingThisChannel: boolean;
  onStartPvr: (stopAtMs: number, label: string, startAtMs?: number) => void;
  onStopPvr: () => void;
  /** Inline on live TV toolbar row (beside REC / Screen off). */
  compact?: boolean;
}

function toRecordTarget(
  showSelection: PvrShowSelection | null,
  nowProg: { start: number; stop: number; title: string } | null
): PvrShowSelection | null {
  if (isPvrShowSelectionRecordable(showSelection)) return showSelection;
  if (nowProg && nowProg.stop > Date.now() + 15_000) {
    return {
      programmeStart: nowProg.start,
      programmeStop: nowProg.stop,
      title: nowProg.title,
    };
  }
  return null;
}

export function PlayerPvrBar({
  channel,
  canRecord,
  recordBusy,
  recordingCompact,
  onRecordingCompactChange,
  channelPvrSession,
  recordingThisChannel,
  onStartPvr,
  onStopPvr,
  compact = false,
}: PlayerPvrBarProps) {
  const [epgTick, setEpgTick] = useState(0);
  const [showSelectionTick, setShowSelectionTick] = useState(0);
  const [countdownTick, setCountdownTick] = useState(0);

  useEffect(() => {
    const onEpg = (ev: Event) => {
      const detail = (ev as CustomEvent<ChannelEpgUpdatedDetail>).detail;
      if (detail?.channelId === channel.id) setEpgTick((n) => n + 1);
    };
    const onShowSel = (ev: Event) => {
      const detail = (ev as CustomEvent<PvrShowSelectionDetail>).detail;
      if (detail?.channelId === channel.id) setShowSelectionTick((n) => n + 1);
    };
    window.addEventListener(CHANNEL_EPG_UPDATED_EVENT, onEpg);
    window.addEventListener(PVR_SHOW_SELECTION_EVENT, onShowSel);
    return () => {
      window.removeEventListener(CHANNEL_EPG_UPDATED_EVENT, onEpg);
      window.removeEventListener(PVR_SHOW_SELECTION_EVENT, onShowSel);
    };
  }, [channel.id]);

  useEffect(() => {
    if (!channelPvrSession) return;
    const id = window.setInterval(() => setCountdownTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [channelPvrSession]);

  const epgCache = useMemo(() => getChannelEpgCache(channel.id), [channel.id, epgTick]);
  const nowProg = useMemo(
    () => (epgCache?.programmes.length ? currentProgramme(epgCache.programmes) : null),
    [epgCache]
  );
  const showSelection = useMemo(
    () => getPvrShowSelection(channel.id),
    [channel.id, showSelectionTick]
  );
  void countdownTick;

  const recordTarget = useMemo(
    () => toRecordTarget(showSelection, nowProg),
    [showSelection, nowProg]
  );
  const recordReady = !!recordTarget;

  const pvrScheduled = channelPvrSession?.status === "scheduled";
  const pvrRecording = channelPvrSession?.status === "recording";
  const hasPvrJobOnChannel = !!channelPvrSession;
  const msLeft = pvrRecording
    ? Math.max(0, channelPvrSession!.stopAtMs - Date.now())
    : 0;
  const msUntilStart = pvrScheduled
    ? Math.max(0, channelPvrSession!.startAtMs - Date.now())
    : 0;
  const progress = pvrRecording
    ? pvrProgressPercent(channelPvrSession!.startedAtMs, channelPvrSession!.stopAtMs)
    : 0;

  const willSchedule =
    !!recordTarget && recordTarget.programmeStart > Date.now() + 60_000;

  const startDisabled =
    !canRecord || recordBusy || hasPvrJobOnChannel || recordingThisChannel || !recordReady;

  const startTitle = !canRecord
    ? "PVR needs the desktop app and a recordable stream"
    : !recordReady
      ? "Open EPG below and click the show to record (start → end)"
      : willSchedule
        ? `Schedule ${recordTarget!.title} (${formatEpgClock(recordTarget!.programmeStart)} – ${formatEpgClock(recordTarget!.programmeStop)})`
        : `Record ${recordTarget!.title} until ${formatEpgClock(recordTarget!.programmeStop)}`;

  const handleStart = useCallback(() => {
    if (!recordTarget) return;
    const built = buildPvrScheduleFromShow(
      recordTarget.programmeStart,
      recordTarget.programmeStop,
      recordTarget.title
    );
    if (!built) return;
    onStartPvr(built.stopAtMs, built.label, built.startAtMs);
  }, [recordTarget, onStartPvr]);

  if (compact) {
    return (
      <section
        className="player-pvr-bar player-pvr-bar--compact"
        aria-label="Personal video recorder"
      >
        {pvrScheduled ? (
          <p className="player-pvr-scheduled-note" role="status" aria-live="polite">
            <span className="player-pvr-scheduled-text">
              PVR recording will start in{" "}
              <strong className="player-pvr-scheduled-countdown">{formatPvrCountdown(msUntilStart)}</strong>
            </span>
            <button type="button" className="player-pvr-scheduled-cancel" onClick={() => onStopPvr()}>
              Cancel
            </button>
          </p>
        ) : pvrRecording ? (
          <div className="player-pvr-active player-pvr-active--strip" role="status">
            <div className="player-pvr-active-meta">
              <span className="player-pvr-active-label">Recording · {channelPvrSession!.label}</span>
              <span className="player-pvr-countdown" aria-live="polite">
                {formatPvrCountdown(msLeft)} left
                <span className="player-pvr-until">until {formatEpgClock(channelPvrSession!.stopAtMs)}</span>
              </span>
            </div>
            <div className="player-pvr-active-scale-row">
              <div
                className="player-pvr-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <span className="player-pvr-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <button
                type="button"
                className="player-pvr-stop-btn"
                disabled={recordBusy}
                onClick={() => onStopPvr()}
              >
                Stop
              </button>
            </div>
          </div>
        ) : (
          <div className="player-pvr-controls">
            <button
              type="button"
              className="player-pvr-start-btn"
              disabled={startDisabled}
              title={startTitle}
              onClick={() => handleStart()}
            >
              {willSchedule ? "Schedule" : "Record"}
            </button>
            <label
              className="player-pvr-compact-toggle"
              title="Re-encode on save: max 720p width, ~2.5 Mbps video, 96 kbps audio"
            >
              <input
                type="checkbox"
                checked={recordingCompact}
                disabled={recordBusy || recordingThisChannel}
                onChange={(e) => onRecordingCompactChange(e.target.checked)}
              />
              Small
            </label>
            {recordTarget ? (
              <span
                className="player-pvr-show-chip"
                title={`${recordTarget.title} · ${formatEpgTimeRange(recordTarget.programmeStart, recordTarget.programmeStop)}`}
              >
                <strong>{recordTarget.title}</strong>
                <span className="player-pvr-show-chip-times">
                  {formatEpgClock(recordTarget.programmeStart)}→{formatEpgClock(recordTarget.programmeStop)}
                </span>
              </span>
            ) : (
              <span className="player-pvr-show-chip player-pvr-show-chip--muted" title="Open EPG below and click a listing">
                EPG
              </span>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="player-pvr-bar" aria-label="Personal video recorder">
      <div className="player-pvr-head">
        <span className="player-pvr-label">PVR</span>
        <span className="player-pvr-head-hint">Schedule a show from the program guide below</span>
      </div>

      {pvrScheduled ? (
        <p className="player-pvr-scheduled-note" role="status" aria-live="polite">
          PVR recording will start in{" "}
          <strong className="player-pvr-scheduled-countdown">{formatPvrCountdown(msUntilStart)}</strong> (
          {formatEpgClock(channelPvrSession!.startAtMs)}) ·{" "}
          <button type="button" className="player-pvr-scheduled-cancel" onClick={() => onStopPvr()}>
            Cancel
          </button>
        </p>
      ) : null}

      {pvrRecording ? (
        <div className="player-pvr-active" role="status">
          <div className="player-pvr-active-meta">
            <span className="player-pvr-active-label">Recording · {channelPvrSession!.label}</span>
            <span className="player-pvr-countdown" aria-live="polite">
              {formatPvrCountdown(msLeft)} left
              <span className="player-pvr-until">until {formatEpgClock(channelPvrSession!.stopAtMs)}</span>
            </span>
          </div>
          <div className="player-pvr-active-scale-row">
            <div
              className="player-pvr-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <span className="player-pvr-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <button
              type="button"
              className="player-pvr-stop-btn"
              disabled={recordBusy}
              onClick={() => onStopPvr()}
            >
              Stop PVR
            </button>
          </div>
        </div>
      ) : !pvrScheduled ? (
        <div className="player-pvr-body">
          <div className="player-pvr-program" aria-live="polite">
            {recordTarget ? (
              <>
                <div className="player-pvr-program-title">
                  <strong>{recordTarget.title}</strong>
                </div>
                <div className="player-pvr-window">
                  <div className="player-pvr-window-row">
                    <span className="player-pvr-window-key">Start</span>
                    <span className="player-pvr-window-val">{formatEpgClock(recordTarget.programmeStart)}</span>
                  </div>
                  <span className="player-pvr-window-arrow" aria-hidden>
                    →
                  </span>
                  <div className="player-pvr-window-row">
                    <span className="player-pvr-window-key">End</span>
                    <span className="player-pvr-window-val">{formatEpgClock(recordTarget.programmeStop)}</span>
                  </div>
                </div>
                <p className="player-pvr-program-range">
                  {formatEpgTimeRange(recordTarget.programmeStart, recordTarget.programmeStop)}
                </p>
              </>
            ) : (
              <p className="player-pvr-program-empty">
                Open <strong>EPG</strong> below and click the show you want.
              </p>
            )}
          </div>

          <div className="player-pvr-controls">
            <label className="player-pvr-compact-toggle" title="Re-encode on save">
              <input
                type="checkbox"
                checked={recordingCompact}
                disabled={recordBusy || recordingThisChannel}
                onChange={(e) => onRecordingCompactChange(e.target.checked)}
              />
              Smaller files
            </label>
            <button
              type="button"
              className="player-pvr-start-btn"
              disabled={startDisabled}
              title={startTitle}
              onClick={() => handleStart()}
            >
              {willSchedule ? "Schedule PVR" : "PVR Record"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
