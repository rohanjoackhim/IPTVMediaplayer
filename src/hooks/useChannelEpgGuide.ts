import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Channel } from "../types";
import { currentProgramme } from "../utils/epgService";
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
import {
  getPvrShowSelection,
  PVR_SHOW_SELECTION_EVENT,
  setPvrShowSelection,
  type PvrShowSelectionDetail,
} from "../utils/pvrSession";
import { guardLlmApiKey, LLM_KEY_SETUP_HINT } from "../utils/llmApiKeyGuide";

export const EPG_WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000;
export const EPG_WINDOW_AFTER_MS = 8 * 60 * 60 * 1000;

export type EpgUiStatus = "idle" | "loading" | "ready" | "unavailable";

export interface ChannelEpgGuideApi {
  channel: Channel;
  status: EpgUiStatus;
  panelOpen: boolean;
  err: string | null;
  windowProgrammes: EpgProgramme[];
  epgChannelId: string | null;
  epgSourceHint: string | null;
  lookupBusy: boolean;
  nowMs: number;
  nowProg: ReturnType<typeof currentProgramme>;
  windowSpanMs: number;
  pvrShowSelection: ReturnType<typeof getPvrShowSelection>;
  trackRef: RefObject<HTMLDivElement>;
  nowRef: RefObject<HTMLButtonElement>;
  handlePrimaryEpgClick: () => void;
  runLookup: (mode: "all" | "online" | "llm") => void;
  selectProgrammeForPvr: (p: EpgProgramme) => void;
}

export function useChannelEpgGuide(channel: Channel | null): ChannelEpgGuideApi | null {
  const [status, setStatus] = useState<EpgUiStatus>("idle");
  const [panelOpen, setPanelOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [windowProgrammes, setWindowProgrammes] = useState<EpgProgramme[]>([]);
  const [epgChannelId, setEpgChannelId] = useState<string | null>(null);
  const [epgSourceHint, setEpgSourceHint] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [pvrSelectionTick, setPvrSelectionTick] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLButtonElement>(null);

  const applyFromCache = useCallback(() => {
    if (!channel) return false;
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
  }, [channel]);

  useEffect(() => {
    if (!channel) return;
    setPanelOpen(false);
    if (applyFromCache()) return;
    setStatus("idle");
    setErr(null);
    setWindowProgrammes([]);
    setEpgChannelId(null);
    setEpgSourceHint(null);
  }, [channel?.id, applyFromCache]);

  useEffect(() => {
    if (!channel) return;
    const onUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<ChannelEpgUpdatedDetail>).detail;
      if (!detail || detail.channelId !== channel.id) return;
      setEpgChannelId(channel.tvgId ?? channel.id);
      setWindowProgrammes(detail.programmes);
      setEpgSourceHint(detail.source);
      setStatus(detail.programmes.length ? "ready" : "unavailable");
      setErr(detail.programmes.length ? null : EPG_NOT_AVAILABLE);
      if (detail.programmes.length) setPanelOpen(true);
    };
    window.addEventListener(CHANNEL_EPG_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(CHANNEL_EPG_UPDATED_EVENT, onUpdated);
  }, [channel]);

  useEffect(() => {
    if (!channel) return;
    const onShowSel = (ev: Event) => {
      const detail = (ev as CustomEvent<PvrShowSelectionDetail>).detail;
      if (detail?.channelId === channel.id) setPvrSelectionTick((n) => n + 1);
    };
    window.addEventListener(PVR_SHOW_SELECTION_EVENT, onShowSel);
    return () => window.removeEventListener(PVR_SHOW_SELECTION_EVENT, onShowSel);
  }, [channel?.id]);

  const finishLookup = useCallback(
    (programmes: EpgProgramme[], source: string, error?: string) => {
      if (!channel) return;
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
    },
    [channel]
  );

  const runLookup = useCallback(
    async (mode: "all" | "online" | "llm") => {
      if (!channel) return;
      if (mode === "llm") {
        const ok = await guardLlmApiKey("any", "TV program guide (LLM)");
        if (!ok) {
          setLookupBusy(false);
          setStatus("unavailable");
          setErr(LLM_KEY_SETUP_HINT);
          return;
        }
      }
      setPanelOpen(true);
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

  const handlePrimaryEpgClick = useCallback(() => {
    if (panelOpen) {
      setPanelOpen(false);
      return;
    }
    setPanelOpen(true);
    if (status === "ready" && windowProgrammes.length > 0) return;
    if (lookupBusy) return;
    void runLookup("all");
  }, [lookupBusy, panelOpen, runLookup, status, windowProgrammes.length]);

  const selectProgrammeForPvr = useCallback(
    (p: EpgProgramme) => {
      if (!channel || p.stop <= Date.now() + 15_000) return;
      setPvrShowSelection(channel.id, {
        programmeStart: p.start,
        programmeStop: p.stop,
        title: p.title,
      });
    },
    [channel]
  );

  const nowMs = Date.now();
  const nowProg = useMemo(() => currentProgramme(windowProgrammes, nowMs), [windowProgrammes, nowMs]);
  const pvrShowSelection = useMemo(
    () => (channel ? getPvrShowSelection(channel.id) : null),
    [channel?.id, pvrSelectionTick]
  );

  useEffect(() => {
    if (status !== "ready" || !nowRef.current) return;
    nowRef.current.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [status, windowProgrammes.length, channel?.id]);

  if (!channel) return null;

  return {
    channel,
    status,
    panelOpen,
    err,
    windowProgrammes,
    epgChannelId,
    epgSourceHint,
    lookupBusy,
    nowMs,
    nowProg,
    windowSpanMs: EPG_WINDOW_BEFORE_MS + EPG_WINDOW_AFTER_MS,
    pvrShowSelection,
    trackRef,
    nowRef,
    handlePrimaryEpgClick,
    runLookup,
    selectProgrammeForPvr,
  };
}
