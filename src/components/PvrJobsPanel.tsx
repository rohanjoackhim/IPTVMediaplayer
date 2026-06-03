import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatEpgClock, formatEpgTimeRange } from "../utils/epgService";
import { formatPvrCountdown, pvrProgressPercent } from "../utils/pvrRecording";
import type { PvrManagedSession } from "../utils/pvrRecordingManager";
import "./PvrJobsPanel.css";

export interface PvrJobsPanelProps {
  activeSessions: PvrManagedSession[];
  history: PvrManagedSession[];
  onStopJob: (sessionId: string) => void;
  onGoToChannel: (channelId: string, pane: "L" | "R") => void;
  onRevealFile?: (filePath: string) => void;
  onClearHistory?: () => void;
}

function statusLabel(status: PvrManagedSession["status"]): string {
  switch (status) {
    case "scheduled":
      return "Sched";
    case "recording":
      return "Rec";
    case "completed":
      return "Done";
    case "cancelled":
      return "Off";
    default:
      return status;
  }
}

function paneShort(pane: "L" | "R"): string {
  return pane === "L" ? "S1" : "S2";
}

function shortenPath(path: string, max = 40): string {
  const p = path.trim();
  if (p.length <= max) return p;
  const head = Math.floor(max * 0.38);
  const tail = max - head - 1;
  return `${p.slice(0, head)}…${p.slice(-tail)}`;
}

export function PvrJobsPanel({
  activeSessions,
  history,
  onStopJob,
  onGoToChannel,
  onRevealFile,
  onClearHistory,
}: PvrJobsPanelProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!activeSessions.length) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeSessions.length]);
  void tick;

  const scheduled = activeSessions.filter((s) => s.status === "scheduled");
  const recording = activeSessions.filter((s) => s.status === "recording");
  const hasReveal = typeof onRevealFile === "function" && !!window.iptv?.showRecordInFolder;
  const empty = !activeSessions.length && !history.length;

  const summary = useMemo(() => {
    const parts: string[] = [];
    if (scheduled.length) parts.push(`${scheduled.length} sched`);
    if (recording.length) parts.push(`${recording.length} rec`);
    if (history.length) parts.push(`${history.length} done`);
    return parts.join(" · ");
  }, [scheduled.length, recording.length, history.length]);

  const renderRow = (s: PvrManagedSession, opts: { showStop: boolean; showGo: boolean }) => {
    const now = Date.now();
    const isScheduled = s.status === "scheduled";
    const isRecording = s.status === "recording";
    const msLeft = Math.max(0, s.stopAtMs - now);
    const msUntilStart = Math.max(0, s.startAtMs - now);
    const progress = isRecording ? pvrProgressPercent(s.startedAtMs, s.stopAtMs) : 0;
    const timeRange = formatEpgTimeRange(s.startAtMs, s.stopAtMs);
    const timingMeta = isScheduled
      ? `starts ${formatPvrCountdown(msUntilStart)}`
      : isRecording
        ? `${formatPvrCountdown(msLeft)} left`
        : s.completedAtMs
          ? `ended ${formatEpgClock(s.completedAtMs)}`
          : null;

    return (
      <li key={`${s.status}-${s.sessionId}`}>
        <article className={`pvr-jobs-card pvr-jobs-card--${s.status}`}>
          <div className="pvr-jobs-card-body">
            <div className="pvr-jobs-card-text">
              <div className="pvr-jobs-card-line1">
                <span className={`pvr-jobs-status pvr-jobs-status--${s.status}`}>{statusLabel(s.status)}</span>
                <span className="pvr-jobs-pane">{paneShort(s.pane)}</span>
                <span className="pvr-jobs-channel" title={s.channelName}>
                  {s.channelName}
                </span>
              </div>
              <p className="pvr-jobs-card-line2" title={s.label}>
                <span className="pvr-jobs-show">{s.label}</span>
                <span className="pvr-jobs-sep">·</span>
                <span className="pvr-jobs-range">{timeRange}</span>
                {timingMeta ? (
                  <>
                    <span className="pvr-jobs-sep">·</span>
                    <span
                      className={
                        isScheduled || isRecording ? "pvr-jobs-timing pvr-jobs-timing--live" : "pvr-jobs-timing"
                      }
                    >
                      {timingMeta}
                    </span>
                  </>
                ) : null}
              </p>
              {isRecording ? (
                <div
                  className="pvr-jobs-progress"
                  role="progressbar"
                  aria-valuenow={Math.round(progress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="pvr-jobs-progress-fill" style={{ width: `${progress}%` }} />
                </div>
              ) : null}
              {s.filePath ? (
                <code className="pvr-jobs-path" title={s.filePath}>
                  {shortenPath(s.filePath)}
                </code>
              ) : s.status === "completed" ? (
                <span className="pvr-jobs-path-missing">No file saved</span>
              ) : null}
            </div>
            <div className="pvr-jobs-card-actions">
              {opts.showGo ? (
                <button
                  type="button"
                  className="pvr-jobs-btn pvr-jobs-btn--go"
                  title={`Go to ${s.channelName}`}
                  onClick={() => onGoToChannel(s.channelId, s.pane)}
                >
                  Go
                </button>
              ) : null}
              {s.filePath && hasReveal ? (
                <button
                  type="button"
                  className="pvr-jobs-btn pvr-jobs-btn--folder"
                  title={s.filePath}
                  onClick={() => onRevealFile?.(s.filePath!)}
                >
                  File
                </button>
              ) : null}
              {opts.showStop ? (
                <button
                  type="button"
                  className="pvr-jobs-btn pvr-jobs-btn--stop"
                  onClick={() => onStopJob(s.sessionId)}
                >
                  {isScheduled ? "Cancel" : "Stop"}
                </button>
              ) : null}
            </div>
          </div>
        </article>
      </li>
    );
  };

  const renderSection = (
    title: string,
    items: PvrManagedSession[],
    opts: { showStop: boolean; showGo: boolean },
    extraHead?: ReactNode
  ) => (
    <section className="pvr-jobs-section">
      <div className="pvr-jobs-section-head">
        <h3 className="pvr-jobs-section-title">{title}</h3>
        {extraHead}
      </div>
      <ul className="pvr-jobs-list">{items.map((s) => renderRow(s, opts))}</ul>
    </section>
  );

  return (
    <div className="pvr-jobs-panel">
      {summary ? <p className="pvr-jobs-summary">{summary}</p> : null}
      {empty ? (
        <p className="pvr-jobs-empty">No PVR jobs yet. Use the player PVR bar to record or schedule a show.</p>
      ) : (
        <>
          {scheduled.length
            ? renderSection(`Scheduled (${scheduled.length})`, scheduled, { showStop: true, showGo: true })
            : null}
          {recording.length
            ? renderSection(`Recording (${recording.length})`, recording, { showStop: true, showGo: true })
            : null}
          {history.length
            ? renderSection(
                `Completed (${history.length})`,
                history,
                { showStop: false, showGo: true },
                onClearHistory ? (
                  <button type="button" className="pvr-jobs-clear-history" onClick={() => onClearHistory()}>
                    Clear
                  </button>
                ) : null
              )
            : null}
        </>
      )}
    </div>
  );
}
