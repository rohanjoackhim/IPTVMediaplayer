import {
  epgSystemTimeZoneNote,
  formatEpgClock,
  formatEpgTimeRange,
} from "../utils/epgService";
import { EPG_NOT_AVAILABLE } from "../utils/channelEpgLookup";
import { EPG_WINDOW_BEFORE_MS, type ChannelEpgGuideApi } from "../hooks/useChannelEpgGuide";
import { isMissingLlmKeyMessage } from "../utils/llmApiKeyGuide";
import { LlmKeyGuideInline } from "./LlmKeyGuideInline";
import "./ChannelEpgGuide.css";

export interface ChannelEpgGuideProps {
  guide: ChannelEpgGuideApi;
}

/** Expandable program guide panel (toolbar buttons are in `ChannelEpgToolbar`). */
export function ChannelEpgGuide({ guide }: ChannelEpgGuideProps) {
  const {
    status,
    panelOpen,
    err,
    windowProgrammes,
    epgChannelId,
    epgSourceHint,
    nowMs,
    nowProg,
    windowSpanMs,
    pvrShowSelection,
    trackRef,
    nowRef,
    selectProgrammeForPvr,
  } = guide;

  const showExpandedPanel = panelOpen;

  return (
    <section
      className={`channel-epg${panelOpen ? "" : " channel-epg--collapsed"}`}
      aria-label="Electronic program guide"
    >
      <div className="channel-epg-head">
        <span className="channel-epg-label">Program guide</span>
        {nowProg ? (
          <span className="channel-epg-now" title={nowProg.description}>
            Now: <strong>{nowProg.title}</strong>
            <span className="channel-epg-now-time">
              {" · "}
              {formatEpgTimeRange(nowProg.start, nowProg.stop)}
            </span>
          </span>
        ) : status === "ready" ? (
          <span className="channel-epg-now channel-epg-now--muted">No current listing</span>
        ) : null}
        {showExpandedPanel && epgChannelId && status === "ready" ? (
          <span className="channel-epg-id" title="Matched XMLTV channel id">
            {epgChannelId}
          </span>
        ) : null}
        {showExpandedPanel && epgSourceHint && status === "ready" ? (
          <span className="channel-epg-source" title="EPG data source">
            {epgSourceHint}
          </span>
        ) : null}
      </div>

      {showExpandedPanel && status === "idle" ? (
        <p className="channel-epg-hint">Use <strong>EPG</strong> above to load listings (web XMLTV, then LLM if needed).</p>
      ) : null}
      {showExpandedPanel && status === "loading" ? (
        <p className="channel-epg-hint">Loading EPG…</p>
      ) : null}
      {showExpandedPanel && status === "unavailable" ? (
        <div className="channel-epg-err-wrap" role="status">
          <p className="channel-epg-err">{err ?? EPG_NOT_AVAILABLE}</p>
          {isMissingLlmKeyMessage(err) ? <LlmKeyGuideInline /> : null}
        </div>
      ) : null}

      {showExpandedPanel ? (
        <p className="channel-epg-pvr-hint">
          Click a listing to set PVR <strong>start</strong> and <strong>end</strong> times
          {pvrShowSelection ? (
            <>
              {" "}
              — selected: <strong>{pvrShowSelection.title}</strong> (
              {formatEpgTimeRange(pvrShowSelection.programmeStart, pvrShowSelection.programmeStop)})
            </>
          ) : null}
        </p>
      ) : null}

      {showExpandedPanel && status === "ready" && windowProgrammes.length > 0 ? (
        <div ref={trackRef} className="channel-epg-track" role="list">
          {windowProgrammes.map((p) => {
            const isNow = p.start <= nowMs && p.stop > nowMs;
            const isEnded = p.stop <= nowMs + 15_000;
            const isFuture = p.start > nowMs + 60_000;
            const isPvrSelected =
              pvrShowSelection != null &&
              pvrShowSelection.programmeStart === p.start &&
              pvrShowSelection.programmeStop === p.stop;
            const durationMin = Math.max(1, Math.round((p.stop - p.start) / 60_000));
            const flexGrow = Math.max(1, durationMin);
            return (
              <button
                key={`${p.channelId}-${p.start}`}
                ref={isNow ? nowRef : undefined}
                type="button"
                role="listitem"
                className={`channel-epg-slot${isNow ? " channel-epg-slot--now" : ""}${
                  isFuture ? " channel-epg-slot--future" : ""
                }${isPvrSelected ? " channel-epg-slot--pvr-selected" : ""}${
                  !isEnded ? " channel-epg-slot--selectable" : " channel-epg-slot--ended"
                }`}
                style={{ flexGrow, flexBasis: `${Math.min(100, flexGrow * 4)}px` }}
                disabled={isEnded}
                title={[
                  p.title,
                  p.description,
                  formatEpgTimeRange(p.start, p.stop),
                  isEnded ? "This listing has ended" : "Select for PVR · record from start to end",
                ]
                  .filter(Boolean)
                  .join("\n")}
                aria-current={isNow ? "true" : undefined}
                aria-pressed={isPvrSelected}
                onClick={() => selectProgrammeForPvr(p)}
              >
                <span className="channel-epg-slot-time">{formatEpgClock(p.start)}</span>
                <span className="channel-epg-slot-title">{p.title}</span>
                <span className="channel-epg-slot-dur">{durationMin}m</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {showExpandedPanel && status === "ready" && windowProgrammes.length > 0 ? (
        <div
          className="channel-epg-timeline"
          aria-hidden
          style={{
            background: `linear-gradient(90deg, transparent 0%, var(--accent-muted) ${(EPG_WINDOW_BEFORE_MS / windowSpanMs) * 100}%, transparent ${(EPG_WINDOW_BEFORE_MS / windowSpanMs) * 100}%)`,
          }}
        />
      ) : null}

      {showExpandedPanel && status === "ready" && windowProgrammes.length > 0 ? (
        <p className="channel-epg-tz-note">{epgSystemTimeZoneNote()}</p>
      ) : null}
    </section>
  );
}
