import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel } from "../types";
import {
  currentProgramme,
  epgSystemTimeZoneNote,
  formatEpgClock,
  formatEpgTimeRange,
} from "../utils/epgService";
import {
  EPG_NOT_AVAILABLE,
  lookupChannelEpg,
  lookupChannelEpgLlm,
  lookupChannelEpgOnline,
} from "../utils/channelEpgLookup";
import {
  CHANNEL_EPG_UPDATED_EVENT,
  getChannelEpgCache,
  type ChannelEpgUpdatedDetail,
} from "../utils/channelEpgSession";
import type { EpgProgramme } from "../utils/xmltvParser";
import { guardLlmApiKey, isMissingLlmKeyMessage, LLM_KEY_SETUP_HINT } from "../utils/llmApiKeyGuide";
import { LlmKeyGuideInline } from "./LlmKeyGuideInline";
import "./ChannelEpgGuide.css";

const WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 8 * 60 * 60 * 1000;

export interface ChannelEpgGuideProps {
  channel: Channel;
}

type EpgUiStatus = "idle" | "loading" | "ready" | "unavailable";

export function ChannelEpgGuide({ channel }: ChannelEpgGuideProps) {
  const [status, setStatus] = useState<EpgUiStatus>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [windowProgrammes, setWindowProgrammes] = useState<EpgProgramme[]>([]);
  const [epgChannelId, setEpgChannelId] = useState<string | null>(null);
  const [epgSourceHint, setEpgSourceHint] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLButtonElement>(null);

  const applyFromCache = useCallback(() => {
    const cached = getChannelEpgCache(channel.id);
    if (cached?.programmes.length) {
      setEpgChannelId(channel.tvgId ?? channel.id);
      setWindowProgrammes(cached.programmes);
      setEpgSourceHint(cached.source);
      setStatus("ready");
      setErr(null);
      return true;
    }
    return false;
  }, [channel.id, channel.tvgId]);

  useEffect(() => {
    if (applyFromCache()) return;
    setStatus("idle");
    setErr(null);
    setWindowProgrammes([]);
    setEpgChannelId(null);
    setEpgSourceHint(null);
  }, [channel.id, applyFromCache]);

  useEffect(() => {
    const onUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<ChannelEpgUpdatedDetail>).detail;
      if (!detail || detail.channelId !== channel.id) return;
      setEpgChannelId(channel.tvgId ?? channel.id);
      setWindowProgrammes(detail.programmes);
      setEpgSourceHint(detail.source);
      setStatus(detail.programmes.length ? "ready" : "unavailable");
      setErr(detail.programmes.length ? null : EPG_NOT_AVAILABLE);
    };
    window.addEventListener(CHANNEL_EPG_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(CHANNEL_EPG_UPDATED_EVENT, onUpdated);
  }, [channel.id, channel.tvgId]);

  const finishLookup = useCallback((programmes: EpgProgramme[], source: string, error?: string) => {
    setEpgChannelId(channel.tvgId ?? channel.id);
    setWindowProgrammes(programmes);
    setEpgSourceHint(source || null);
    if (programmes.length) {
      setStatus("ready");
      setErr(null);
    } else {
      setStatus("unavailable");
      setErr(error ?? EPG_NOT_AVAILABLE);
    }
  }, [channel.tvgId, channel.id]);

  const runLookup = useCallback(
    async (mode: "all" | "online" | "llm") => {
      if (mode === "llm") {
        const ok = await guardLlmApiKey("any", "TV program guide (LLM)");
        if (!ok) {
          setLookupBusy(false);
          setStatus("unavailable");
          setErr(LLM_KEY_SETUP_HINT);
          return;
        }
      }
      setLookupBusy(true);
      setStatus("loading");
      setErr(null);
      try {
        const res =
          mode === "online"
            ? await lookupChannelEpgOnline(channel)
            : mode === "llm"
              ? await lookupChannelEpgLlm(channel)
              : await lookupChannelEpg(channel);
        finishLookup(res.programmes, res.source, res.error || res.message);
      } catch (e) {
        finishLookup([], "", e instanceof Error ? e.message : EPG_NOT_AVAILABLE);
      } finally {
        setLookupBusy(false);
      }
    },
    [channel, finishLookup]
  );

  const nowMs = Date.now();
  const nowProg = useMemo(() => currentProgramme(windowProgrammes, nowMs), [windowProgrammes, nowMs]);

  useEffect(() => {
    if (status !== "ready" || !nowRef.current) return;
    nowRef.current.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [status, windowProgrammes.length, channel.id]);

  const windowSpanMs = WINDOW_BEFORE_MS + WINDOW_AFTER_MS;

  return (
    <section className="channel-epg" aria-label="Electronic program guide">
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
        {epgChannelId && status === "ready" ? (
          <span className="channel-epg-id" title="Matched XMLTV channel id">
            {epgChannelId}
          </span>
        ) : null}
        {epgSourceHint && status === "ready" ? (
          <span className="channel-epg-source" title="EPG data source">
            {epgSourceHint}
          </span>
        ) : null}
        <div className="channel-epg-lookup-btns">
          <button
            type="button"
            className="channel-epg-lookup-inline-btn channel-epg-lookup-inline-btn--primary"
            disabled={lookupBusy}
            onClick={() => void runLookup("all")}
          >
            {lookupBusy ? "Loading…" : "EPG"}
          </button>
          <button
            type="button"
            className="channel-epg-lookup-inline-btn"
            disabled={lookupBusy}
            onClick={() => void runLookup("online")}
            title="Free XMLTV on the web"
          >
            Web
          </button>
          <button
            type="button"
            className="channel-epg-lookup-inline-btn channel-epg-lookup-inline-btn--llm"
            disabled={lookupBusy}
            onClick={() => void runLookup("llm")}
            title="Estimated schedule via LLM"
          >
            LLM
          </button>
        </div>
      </div>

      {status === "idle" ? (
        <p className="channel-epg-hint">Press <strong>EPG</strong> to load listings (web XMLTV, then LLM if needed).</p>
      ) : null}
      {status === "loading" ? <p className="channel-epg-hint">Loading EPG…</p> : null}
      {status === "unavailable" ? (
        <div className="channel-epg-err-wrap" role="status">
          <p className="channel-epg-err">{err ?? EPG_NOT_AVAILABLE}</p>
          {isMissingLlmKeyMessage(err) ? <LlmKeyGuideInline /> : null}
        </div>
      ) : null}

      {status === "ready" && windowProgrammes.length > 0 ? (
        <div ref={trackRef} className="channel-epg-track" role="list">
          {windowProgrammes.map((p) => {
            const isNow = p.start <= nowMs && p.stop > nowMs;
            const durationMin = Math.max(1, Math.round((p.stop - p.start) / 60_000));
            const flexGrow = Math.max(1, durationMin);
            return (
              <button
                key={`${p.channelId}-${p.start}`}
                ref={isNow ? nowRef : undefined}
                type="button"
                role="listitem"
                className={`channel-epg-slot${isNow ? " channel-epg-slot--now" : ""}`}
                style={{ flexGrow, flexBasis: `${Math.min(100, flexGrow * 4)}px` }}
                title={[p.title, p.description, formatEpgTimeRange(p.start, p.stop)]
                  .filter(Boolean)
                  .join("\n")}
                aria-current={isNow ? "true" : undefined}
              >
                <span className="channel-epg-slot-time">{formatEpgClock(p.start)}</span>
                <span className="channel-epg-slot-title">{p.title}</span>
                <span className="channel-epg-slot-dur">{durationMin}m</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {status === "ready" && windowProgrammes.length > 0 ? (
        <div
          className="channel-epg-timeline"
          aria-hidden
          style={{
            background: `linear-gradient(90deg, transparent 0%, var(--accent-muted) ${(WINDOW_BEFORE_MS / windowSpanMs) * 100}%, transparent ${(WINDOW_BEFORE_MS / windowSpanMs) * 100}%)`,
          }}
        />
      ) : null}

      {status === "ready" && windowProgrammes.length > 0 ? (
        <p className="channel-epg-tz-note">{epgSystemTimeZoneNote()}</p>
      ) : null}
    </section>
  );
}
