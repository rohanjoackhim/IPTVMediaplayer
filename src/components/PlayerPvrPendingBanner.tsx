import { useEffect, useState } from "react";
import { formatEpgClock } from "../utils/epgService";
import { formatPvrCountdown, pvrProgressPercent } from "../utils/pvrRecording";
import type { PvrPendingAction } from "../utils/pvrSession";
import "./PlayerPvrPendingBanner.css";

export interface PlayerPvrPendingBannerProps {
  actions: PvrPendingAction[];
  currentChannelId: string | null;
  currentPane: "L" | "R";
  onStop: (sessionId: string) => void;
  onGoToChannel: (channelId: string, pane: "L" | "R") => void;
}

export function PlayerPvrPendingBanner({
  actions,
  currentChannelId,
  currentPane,
  onStop,
  onGoToChannel,
}: PlayerPvrPendingBannerProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [actions.length]);
  void tick;

  if (!actions.length) return null;

  const scheduled = actions.filter((a) => a.status === "scheduled");
  const recording = actions.filter((a) => a.status === "recording");

  return (
    <div className="player-pvr-pending" role="region" aria-label="PVR recordings">
      <span className="player-pvr-pending-title">
        PVR {recording.length ? `· ${recording.length} recording` : ""}
        {scheduled.length ? ` · ${scheduled.length} scheduled` : ""}
      </span>
      <ul className="player-pvr-pending-list">
        {actions.map((a) => {
          const isScheduled = a.status === "scheduled";
          const now = Date.now();
          const msLeft = Math.max(0, a.stopAtMs - now);
          const msUntilStart = Math.max(0, a.startAtMs - now);
          const progress = isScheduled
            ? 0
            : pvrProgressPercent(a.startedAtMs, a.stopAtMs);
          const onThisChannel = a.channelId === currentChannelId && a.pane === currentPane;
          return (
            <li
              key={a.sessionId}
              className={`player-pvr-pending-item${onThisChannel ? " player-pvr-pending-item--here" : ""}${
                isScheduled ? " player-pvr-pending-item--scheduled" : ""
              }`}
            >
              <div className="player-pvr-pending-item-main">
                <span className="player-pvr-pending-pane">{a.pane === "L" ? "Screen 1" : "Screen 2"}</span>
                <strong className="player-pvr-pending-name">{a.channelName}</strong>
                <span className="player-pvr-pending-meta">
                  {isScheduled ? (
                    <>
                      Scheduled · {a.label} · starts in {formatPvrCountdown(msUntilStart)} (
                      {formatEpgClock(a.startAtMs)})
                    </>
                  ) : (
                    <>
                      {a.label} · {formatPvrCountdown(msLeft)} left · until {formatEpgClock(a.stopAtMs)}
                    </>
                  )}
                </span>
                {!isScheduled ? (
                  <div
                    className="player-pvr-pending-progress"
                    role="progressbar"
                    aria-valuenow={Math.round(progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span className="player-pvr-pending-progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="player-pvr-pending-actions">
                {!onThisChannel ? (
                  <button
                    type="button"
                    className="player-pvr-pending-go"
                    onClick={() => onGoToChannel(a.channelId, a.pane)}
                  >
                    Go to channel
                  </button>
                ) : null}
                <button
                  type="button"
                  className="player-pvr-pending-stop"
                  onClick={() => onStop(a.sessionId)}
                >
                  {isScheduled ? "Cancel" : "Stop"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
