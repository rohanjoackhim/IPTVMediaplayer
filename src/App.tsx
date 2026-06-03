import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import "./App.css";
import { AppSettingsModal } from "./components/AppSettingsModal";
import { ChannelBrowser } from "./components/ChannelBrowser";
import { hasAnyLlmApiKey } from "./utils/lyricsLlmEndpointLabel";
import { OPEN_LLM_SETTINGS_EVENT, type OpenLlmSettingsDetail } from "./utils/llmApiKeyGuide";
import { favoriteKeyForChannel, loadFavoriteUrls, saveFavoriteUrls } from "./utils/favoritesStorage";
import { fetchM3uPlaylist } from "./utils/fetchM3uPlaylist";
import { parseM3U } from "./utils/m3uParser";
import {
  loadLastActiveChannelUrl,
  loadLastPlaylistUrl,
  saveLastActiveChannelUrl,
} from "./utils/playlistSettingsStorage";
import { clearVideoResume } from "./utils/localVideoResumeStorage";
import { clampSidebarWidthPx, loadUiSession, saveUiSession } from "./utils/uiSessionStorage";
import { setStreamProxyToken } from "./utils/streamProxyAuth";
import { isPodcastChannelId, isRadioStationChannelId } from "./utils/recordableStream";
import type { Channel } from "./types";
import { PVR_STOP_REQUEST_EVENT, type PvrStopRequestDetail } from "./utils/pvrSession";
import {
  findPvrSessionForChannel,
  appendPvrHistory,
  removePvrHistoryEntry,
  clearPvrHistory,
  loadPersistedScheduledPvrSessions,
  loadPvrHistory,
  newPvrSessionId,
  persistScheduledPvrSessions,
  shouldSchedulePvrStart,
  startElectronPvrRecord,
  type PvrManagedSession,
  type PvrStartRequest,
} from "./utils/pvrRecordingManager";
import { loadPvrRecordDir, savePvrRecordDir } from "./utils/pvrRecordDirStorage";

const VideoPlayer = lazy(() =>
  import("./components/VideoPlayer").then((m) => ({ default: m.VideoPlayer }))
);

const DEMO_CHANNELS: Channel[] = [
  {
    id: "demo-1",
    name: "Big Buck Bunny (HLS demo)",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    group: "Samples",
  },
  {
    id: "demo-2",
    name: "Sintel (HLS, multi-audio)",
    url: "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
    group: "Samples",
  },
];

function isDemoChannels(ch: Channel[]): boolean {
  if (ch.length !== DEMO_CHANNELS.length) return false;
  return ch.every((c, i) => c.id === DEMO_CHANNELS[i]?.id);
}

function loadStoredChannels(): Channel[] {
  try {
    const raw = localStorage.getItem("iptv-channels");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Channel[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChannels(channels: Channel[]) {
  try {
    localStorage.setItem("iptv-channels", JSON.stringify(channels));
  } catch {
    /* quota or private mode */
  }
}

function minPlayerWidthPx(): number {
  if (typeof window === "undefined") return 300;
  const w = window.innerWidth;
  if (w >= 2560) return 520;
  if (w >= 1920) return 400;
  if (w >= 1440) return 340;
  if (w >= 1100) return 300;
  return 260;
}

function fitSidebarToViewport(px: number): number {
  if (typeof window === "undefined") return clampSidebarWidthPx(px);
  const reserve = minPlayerWidthPx();
  const maxByViewport = window.innerWidth - reserve;
  const cap = Math.min(720, Math.max(260, maxByViewport));
  return Math.round(Math.max(260, Math.min(cap, px)));
}

function revokeLocalVideoBlobUrls(channels: Channel[]) {
  for (const c of channels) {
    if (!c.localVideoFile) continue;
    clearVideoResume(c.id);
    const u = c.url?.trim() ?? "";
    if (!u.toLowerCase().startsWith("blob:")) continue;
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* noop */
    }
  }
}

function sidebarModeForChannel(c: Channel): "tv" | "radio" | "audio" {
  if (isRadioStationChannelId(c.id)) return "radio";
  if (isPodcastChannelId(c.id)) return "radio";
  if (c.libraryTrackId || c.ebookId) return "audio";
  return "tv";
}

function isCompactTvCandidate(c: Channel | null): boolean {
  return !!c?.url?.trim() && !c.ebookId && !c.libraryTrackId;
}

function isIndexedLibraryChannel(c: Channel | null): boolean {
  return !!(c?.libraryTrackId?.trim() || c?.ebookId?.trim());
}

function PlayerLoadingFallback({ splitView }: { splitView: boolean }) {
  if (splitView) {
    return (
      <div className="player-pane player-pane--split">
        <div className="player-split">
          <div className="player-loading-pane" aria-hidden />
          <div className="player-loading-pane" aria-hidden />
        </div>
      </div>
    );
  }
  return (
    <div className="player-pane">
      <div className="player-loading-pane player-loading-pane--solo" aria-hidden />
    </div>
  );
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>(() => {
    const stored = loadStoredChannels();
    return stored.length ? stored : DEMO_CHANNELS;
  });
  const [active, setActive] = useState<Channel | null>(null);
  const [channelRight, setChannelRight] = useState<Channel | null>(null);
  const [lastTvChannel, setLastTvChannel] = useState<Channel | null>(null);
  const [lastRadioChannel, setLastRadioChannel] = useState<Channel | null>(null);
  const [lastAudioChannel, setLastAudioChannel] = useState<Channel | null>(null);
  const [splitView, setSplitView] = useState(false);
  const [assignTarget, setAssignTarget] = useState(() => loadUiSession().assignTarget);
  const [volumeLeft, setVolumeLeft] = useState(() => loadUiSession().volumeLeft);
  const [volumeRight, setVolumeRight] = useState(() => loadUiSession().volumeRight);
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(() => loadFavoriteUrls());
  const [audioLibraryShuffle, setAudioLibraryShuffle] = useState(() => loadUiSession().audioLibraryShuffle);
  const [audioLibraryContinuous, setAudioLibraryContinuous] = useState(
    () => loadUiSession().audioLibraryContinuous
  );
  const [sidebarMode, setSidebarMode] = useState(() => loadUiSession().sidebarMode);
  const [recordingPanes, setRecordingPanes] = useState<Record<"L" | "R", boolean>>({ L: false, R: false });
  const [recordingPaneMeta, setRecordingPaneMeta] = useState<
    Record<"L" | "R", { channelId: string; channelName: string; sourceUrl: string | null } | null>
  >({ L: null, R: null });
  const [pvrSessions, setPvrSessions] = useState<PvrManagedSession[]>(() =>
    loadPersistedScheduledPvrSessions()
  );
  const [pvrHistory, setPvrHistory] = useState<PvrManagedSession[]>(() => loadPvrHistory());
  const [pvrRecordDir, setPvrRecordDir] = useState<string | null>(() => loadPvrRecordDir());
  const pvrRecordDirRef = useRef<string | null>(pvrRecordDir);
  pvrRecordDirRef.current = pvrRecordDir;
  const pvrSessionsRef = useRef(pvrSessions);
  pvrSessionsRef.current = pvrSessions;
  /** Electron: two localhost origins (different ports) so left/right streams do not share one connection pool. */
  const [streamProxyOrigins, setStreamProxyOrigins] = useState<[string, string] | null>(null);
  const [compactView, setCompactView] = useState(() => loadUiSession().compactView);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsWelcome, setSettingsWelcome] = useState(false);
  const [settingsReason, setSettingsReason] = useState<string | null>(null);
  const [llmSetupPromptDismissed, setLlmSetupPromptDismissed] = useState(
    () => loadUiSession().llmSetupPromptDismissed
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => fitSidebarToViewport(loadUiSession().sidebarWidthPx));
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const sidebarWidthLive = useRef(sidebarWidth);
  sidebarWidthLive.current = sidebarWidth;

  useEffect(() => {
    const onOpenLlmSettings = (ev: Event) => {
      const detail = (ev as CustomEvent<OpenLlmSettingsDetail>).detail;
      setSettingsWelcome(detail?.welcome !== false);
      setSettingsReason(detail?.reason?.trim() || null);
      setSettingsOpen(true);
    };
    window.addEventListener(OPEN_LLM_SETTINGS_EVENT, onOpenLlmSettings);
    return () => window.removeEventListener(OPEN_LLM_SETTINGS_EVENT, onOpenLlmSettings);
  }, []);

  useEffect(() => {
    if (!window.iptv?.getLyricsChatTranslateKeyStatus || llmSetupPromptDismissed) return;
    void hasAnyLlmApiKey().then((hasKey) => {
      if (!hasKey) {
        setSettingsWelcome(true);
        setSettingsOpen(true);
      }
    });
  }, [llmSetupPromptDismissed]);

  const dismissLlmSetupPrompt = useCallback(() => {
    setLlmSetupPromptDismissed(true);
    setSettingsWelcome(false);
    saveUiSession({ llmSetupPromptDismissed: true });
    setSettingsOpen(false);
  }, []);

  const openSettings = useCallback(() => {
    setSettingsWelcome(false);
    setSettingsReason(null);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    const fn = window.iptv?.getStreamProxyOrigins;
    if (!fn) return;
    void fn().then((payload) => {
      const list = Array.isArray(payload) ? payload : payload?.origins;
      const token = Array.isArray(payload) ? "" : String(payload?.token ?? "");
      if (!Array.isArray(list) || list.length < 2) return;
      const a = typeof list[0] === "string" ? list[0].trim() : "";
      const b = typeof list[1] === "string" ? list[1].trim() : "";
      if (a && b) {
        setStreamProxyOrigins([a, b]);
        setStreamProxyToken(token);
      }
    });
  }, [splitView]);

  useEffect(() => {
    if (!isDemoChannels(channels)) saveChannels(channels);
  }, [channels]);

  useEffect(() => {
    saveUiSession({ audioLibraryShuffle, audioLibraryContinuous, sidebarMode });
  }, [audioLibraryShuffle, audioLibraryContinuous, sidebarMode]);

  useEffect(() => {
    saveFavoriteUrls(favoriteUrls);
  }, [favoriteUrls]);

  useEffect(() => {
    saveUiSession({ splitView, assignTarget, volumeLeft, volumeRight });
  }, [splitView, assignTarget, volumeLeft, volumeRight]);

  useEffect(() => {
    saveUiSession({ compactView });
  }, [compactView]);

  const compactTvChannel = useMemo(
    () => (isCompactTvCandidate(lastTvChannel) ? lastTvChannel : null),
    [lastTvChannel]
  );
  const showCompactReaderWithTv =
    compactView && !!active?.ebookId && !!compactTvChannel && !splitView;
  const soloLayoutMode = compactView && active?.ebookId ? "compactReader" as const : "default" as const;

  useEffect(() => {
    const onResize = () => {
      setSidebarWidth((w) => {
        const n = fitSidebarToViewport(w);
        saveUiSession({ sidebarWidthPx: n });
        return n;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem("iptv-parse-message");
    } catch {
      /* noop */
    }
  }, []);

  /** Refetch last playlist URL on launch when one is saved (channels + favorites stay in local storage). */
  useEffect(() => {
    const url = loadLastPlaylistUrl();
    if (!url) return;
    let cancelled = false;
    void fetchM3uPlaylist(url)
      .then((text) => {
        if (cancelled) return;
        const { channels: next } = parseM3U(text);
        if (next.length) setChannels(next);
      })
      .catch(() => {
        /* keep channels from localStorage */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const channelListKey = useMemo(
    () => `${channels.length}:${channels[0]?.id ?? ""}:${channels[channels.length - 1]?.id ?? ""}`,
    [channels]
  );

  useEffect(() => {
    if (channels.length === 0) return;
    const last = loadLastActiveChannelUrl();
    if (!last) return;
    const found = channels.find((c) => favoriteKeyForChannel(c) === last);
    if (!found) return;
    setActive((prev) => {
      if (prev && channels.some((c) => c.id === prev.id)) return prev;
      setLastTvChannel(found);
      return found;
    });
  }, [channelListKey]);

  useEffect(() => {
    if (!active?.url?.trim()) {
      saveLastActiveChannelUrl(null);
      return;
    }
    const u = active.url.trim().toLowerCase();
    if (u.startsWith("blob:") || u.startsWith("file:")) return;
    saveLastActiveChannelUrl(active.url);
  }, [active]);

  const toggleFavoriteChannel = useCallback((c: Channel | null) => {
    if (!c?.url?.trim()) return;
    const key = favoriteKeyForChannel(c);
    setFavoriteUrls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSplitViewChange = useCallback((v: boolean) => {
    setSplitView(v);
    if (!v) setChannelRight(null);
  }, []);

  const rememberLastPlayed = useCallback((c: Channel | null) => {
    if (!c) return;
    const mode = sidebarModeForChannel(c);
    if (mode === "radio") setLastRadioChannel(c);
    else if (mode === "audio") setLastAudioChannel(c);
    else setLastTvChannel(c);
  }, []);

  const setPrimaryActiveChannel = useCallback(
    (c: Channel | null) => {
      setActive(c);
      rememberLastPlayed(c);
    },
    [rememberLastPlayed]
  );

  const setRightActiveChannel = useCallback(
    (c: Channel | null) => {
      setChannelRight(c);
      rememberLastPlayed(c);
    },
    [rememberLastPlayed]
  );

  useEffect(() => {
    void window.iptv?.setSplitScreenPreference?.(splitView);
    const unsubscribe = window.iptv?.onSplitScreenPreferenceChange?.((enabled) => {
      handleSplitViewChange(enabled);
    });
    return () => {
      unsubscribe?.();
    };
  }, [handleSplitViewChange, splitView]);

  const handleSelectChannel = useCallback(
    (c: Channel) => {
      if (c.ebookId) {
        setPrimaryActiveChannel(c);
        return;
      }
      if (!splitView) {
        setPrimaryActiveChannel(c);
        return;
      }
      if (assignTarget === "L") setPrimaryActiveChannel(c);
      else setRightActiveChannel(c);
    },
    [assignTarget, setPrimaryActiveChannel, setRightActiveChannel, splitView]
  );

  const handleSidebarModeChange = useCallback(
    (mode: "tv" | "radio" | "audio") => {
      setSidebarMode(mode);
      const restore =
        mode === "radio"
          ? lastRadioChannel
          : mode === "audio"
            ? lastAudioChannel
            : lastTvChannel;
      if (restore) setPrimaryActiveChannel(restore);
    },
    [lastAudioChannel, lastRadioChannel, lastTvChannel, setPrimaryActiveChannel]
  );

  const canResetTelevisionStream = useMemo(() => {
    const target = splitView && assignTarget === "R" ? channelRight : active;
    return !!target?.url?.trim() && !target.ebookId && !target.libraryTrackId;
  }, [active, assignTarget, channelRight, splitView]);

  const handleResetTelevisionStream = useCallback(() => {
    const bump = (c: Channel | null): Channel | null => {
      if (!c?.url?.trim() || c.ebookId || c.libraryTrackId) return c;
      return { ...c, streamResetNonce: Date.now() };
    };
    if (splitView && assignTarget === "R") {
      setChannelRight((cur) => {
        const next = bump(cur);
        rememberLastPlayed(next);
        return next;
      });
    } else {
      setActive((cur) => {
        const next = bump(cur);
        rememberLastPlayed(next);
        return next;
      });
    }
  }, [assignTarget, rememberLastPlayed, splitView]);

  const onLoadM3U = useCallback((text: string, replace: boolean): boolean => {
    const { channels: next, errors } = parseM3U(text);
    if (errors.length && next.length === 0) return false;
    setChannels((prev) => {
      if (replace) {
        revokeLocalVideoBlobUrls(prev);
        return next;
      }
      return [...prev, ...next];
    });
    if (replace) setChannelRight(null);
    setActive((cur) => {
      if (replace) {
        const last = loadLastActiveChannelUrl();
        if (last) {
          const byLast = next.find((c) => favoriteKeyForChannel(c) === last);
          if (byLast) {
            setLastTvChannel(byLast);
            return byLast;
          }
        }
        const first = next[0] ?? null;
        setLastTvChannel(first);
        return first;
      }
      if (!cur && next.length) {
        setLastTvChannel(next[0]!);
        return next[0]!;
      }
      return cur;
    });
    return true;
  }, []);

  const onClearList = useCallback(() => {
    setChannels((prev) => {
      revokeLocalVideoBlobUrls(prev);
      return [];
    });
    setActive((cur) => (cur && sidebarModeForChannel(cur) === "tv" ? null : cur));
    setLastTvChannel(null);
    setChannelRight(null);
  }, []);

  const onAddLocalVideoChannels = useCallback((incoming: Channel[]) => {
    if (!incoming.length) return;
    setChannels((prev) => [...incoming, ...prev]);
  }, []);

  const onRemoveChannel = useCallback((channelId: string) => {
    const removed = channels.find((c) => c.id === channelId) ?? null;
    if (!removed) return;
    revokeLocalVideoBlobUrls([removed]);
    setChannels((prev) => prev.filter((c) => c.id !== channelId));
    setActive((cur) => (cur?.id === channelId ? null : cur));
    setChannelRight((cur) => (cur?.id === channelId ? null : cur));
    setLastTvChannel((cur) => (cur?.id === channelId ? null : cur));
  }, [channels]);

  const libraryAudioChannels = useMemo(
    () => channels.filter((c) => !!c.libraryTrackId?.trim() && !c.localVideoFile),
    [channels]
  );

  /** IndexedDB local audio list (order matches sidebar) — not part of M3U `channels`. */
  const [indexedLibraryChannels, setIndexedLibraryChannels] = useState<Channel[]>([]);
  const handleIndexedLibraryChannelsChange = useCallback((list: Channel[]) => {
    setIndexedLibraryChannels(list);
  }, []);

  const handleLocalLibraryAudioEnded = useCallback(
    ({ pane, channelId }: { pane: "L" | "R"; channelId: string }) => {
      if (!audioLibraryContinuous) return;
      const inIndexed = indexedLibraryChannels.some((c) => c.id === channelId);
      const inPlaylist = libraryAudioChannels.some((c) => c.id === channelId);
      const list =
        inIndexed && indexedLibraryChannels.length >= 2
          ? indexedLibraryChannels
          : inPlaylist && libraryAudioChannels.length >= 2
            ? libraryAudioChannels
            : indexedLibraryChannels.length >= 2
              ? indexedLibraryChannels
              : libraryAudioChannels;
      if (list.length < 2) return;
      const idx = list.findIndex((c) => c.id === channelId);
      let next: Channel;
      if (audioLibraryShuffle) {
        const pool = list.filter((c) => c.id !== channelId);
        if (!pool.length) return;
        next = pool[Math.floor(Math.random() * pool.length)]!;
      } else {
        const i = idx >= 0 ? idx : 0;
        next = list[(i + 1) % list.length]!;
      }
      if (splitView) {
        if (pane === "L") setPrimaryActiveChannel(next);
        else setRightActiveChannel(next);
      } else {
        setPrimaryActiveChannel(next);
      }
    },
    [
      audioLibraryContinuous,
      audioLibraryShuffle,
      indexedLibraryChannels,
      libraryAudioChannels,
      setPrimaryActiveChannel,
      setRightActiveChannel,
      splitView,
    ]
  );

  const handleLibraryCleared = useCallback(() => {
    setActive((cur) => (isIndexedLibraryChannel(cur) ? null : cur));
    setChannelRight((cur) => (isIndexedLibraryChannel(cur) ? null : cur));
    setLastAudioChannel((cur) => (isIndexedLibraryChannel(cur) ? null : cur));
  }, []);

  const handleLibraryTrackRemoved = useCallback((trackId: string) => {
    const removedId = trackId.trim();
    if (!removedId) return;
    const isRemovedTrack = (c: Channel | null) => c?.libraryTrackId?.trim() === removedId;
    setActive((cur) => (isRemovedTrack(cur) ? null : cur));
    setChannelRight((cur) => (isRemovedTrack(cur) ? null : cur));
    setLastAudioChannel((cur) => (isRemovedTrack(cur) ? null : cur));
  }, []);

  const setPaneRecording = useCallback(
    (status: {
      pane: "L" | "R";
      recording: boolean;
      channelId?: string | null;
      channelName?: string | null;
      sourceUrl?: string | null;
    }) => {
      const { pane, recording } = status;
      setRecordingPanes((cur) => (cur[pane] === recording ? cur : { ...cur, [pane]: recording }));
      setRecordingPaneMeta((cur) => {
        const nextMeta =
          recording && status.channelId
            ? {
                channelId: status.channelId,
                channelName: (status.channelName ?? "").trim() || "Channel",
                sourceUrl: status.sourceUrl?.trim() || null,
              }
            : null;
        const prev = cur[pane];
        if (
          prev?.channelId === nextMeta?.channelId &&
          prev?.channelName === nextMeta?.channelName &&
          prev?.sourceUrl === nextMeta?.sourceUrl &&
          (prev == null) === (nextMeta == null)
        ) {
          return cur;
        }
        return { ...cur, [pane]: nextMeta };
      });
    },
    []
  );

  const syncPvrSessions = useCallback((next: PvrManagedSession[]) => {
    pvrSessionsRef.current = next;
    setPvrSessions(next);
    persistScheduledPvrSessions(next);
  }, []);

  const refreshPvrHistory = useCallback(() => {
    setPvrHistory(loadPvrHistory());
  }, []);

  const stopPvrSessionById = useCallback(
    async (sessionId: string) => {
      const session = pvrSessionsRef.current.find((s) => s.sessionId === sessionId);
      if (!session) return;

      if (session.status === "scheduled") {
        removePvrHistoryEntry(sessionId);
        syncPvrSessions(pvrSessionsRef.current.filter((s) => s.sessionId !== sessionId));
        refreshPvrHistory();
        return;
      }

      let filePath = session.filePath;
      if (session.status === "recording" && session.recordId && window.iptv?.stopStreamRecord) {
        try {
          console.log(`[PVR] Stopping recording ${session.recordId} for session ${sessionId}`);
          const res = await window.iptv.stopStreamRecord(session.recordId);
          if (res.filePath?.trim()) filePath = res.filePath.trim();
          console.log(`[PVR] Recording stopped, filePath=${filePath}`);
        } catch (e) {
          console.error(`[PVR] Error stopping recording ${session.recordId}:`, e);
        }
      }
      appendPvrHistory({
        ...session,
        status: "completed",
        filePath,
        completedAtMs: Date.now(),
      });
      refreshPvrHistory();
      syncPvrSessions(pvrSessionsRef.current.filter((s) => s.sessionId !== sessionId));
    },
    [refreshPvrHistory, syncPvrSessions]
  );

  const handlePvrRecordDirChange = useCallback((dir: string | null) => {
    const trimmed = dir?.trim() || null;
    setPvrRecordDir(trimmed);
    savePvrRecordDir(trimmed);
  }, []);

  const beginPvrCapture = useCallback(
    async (session: PvrManagedSession) => {
      const live = pvrSessionsRef.current.find((s) => s.sessionId === session.sessionId);
      if (!live) return false;
      if (live.recordId) return true;
      if (!window.iptv?.startStreamRecord) return false;
      const dir = pvrRecordDirRef.current?.trim();
      if (!dir) return false;
      const channel = channels.find((c) => c.id === session.channelId);
      if (!channel?.url?.trim()) return false;
      try {
        const now = Date.now();
        const out = await startElectronPvrRecord(session, channel, dir, now);
        const stopAtMs = out.recordUntilMs ?? session.stopAtMs;
        syncPvrSessions(
          pvrSessionsRef.current.map((s) =>
            s.sessionId === session.sessionId
              ? {
                  ...s,
                  status: "recording" as const,
                  startedAtMs: now,
                  stopAtMs,
                  recordId: out.id,
                  filePath: out.filePath,
                }
              : s
          )
        );
        return true;
      } catch (e) {
        console.error(`[PVR] beginPvrCapture failed for ${session.sessionId}:`, e);
        syncPvrSessions(pvrSessionsRef.current.filter((s) => s.sessionId !== session.sessionId));
        return false;
      }
    },
    [channels, syncPvrSessions]
  );

  const handleRequestStartPvr = useCallback(
    async (req: PvrStartRequest): Promise<{ ok: boolean; error?: string }> => {
      const url = req.channel.url?.trim();
      if (!url) return { ok: false, error: "Channel has no stream URL." };
      if (findPvrSessionForChannel(pvrSessionsRef.current, req.channel.id)) {
        return { ok: false, error: "This channel already has a PVR job (scheduled or recording)." };
      }
      if (!pvrRecordDirRef.current?.trim()) {
        return {
          ok: false,
          error: "Choose a PVR save folder in the Television sidebar PVR tab before recording.",
        };
      }
      const startAtMs = req.startAtMs ?? Date.now();
      const session: PvrManagedSession = {
        sessionId: newPvrSessionId(),
        pane: req.pane,
        channelId: req.channel.id,
        channelName: req.channel.name?.trim() || "Channel",
        sourceUrl: url,
        status: shouldSchedulePvrStart(startAtMs) ? "scheduled" : "recording",
        startAtMs,
        stopAtMs: req.stopAtMs,
        label: req.label,
        startedAtMs: startAtMs,
        recordingCompact: req.recordingCompact,
      };
      syncPvrSessions([...pvrSessionsRef.current, session]);
      if (session.status === "scheduled") return { ok: true };
      const started = await beginPvrCapture(session);
      return started ? { ok: true } : { ok: false, error: "Could not start recording." };
    },
    [beginPvrCapture, syncPvrSessions]
  );

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const list = pvrSessionsRef.current;
      for (const s of list) {
        if (s.status === "scheduled" && s.startAtMs <= now && s.stopAtMs > now + 5_000) {
          void beginPvrCapture(s);
        } else if (s.status === "recording" && s.stopAtMs <= now) {
          void stopPvrSessionById(s.sessionId);
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [beginPvrCapture, stopPvrSessionById]);

  useEffect(() => {
    const onStop = (ev: Event) => {
      const detail = (ev as CustomEvent<PvrStopRequestDetail>).detail;
      if (!detail) return;
      if (detail.sessionId) {
        void stopPvrSessionById(detail.sessionId);
        return;
      }
      const match = pvrSessionsRef.current.find(
        (s) =>
          (detail.channelId ? s.channelId === detail.channelId : true) &&
          (detail.pane ? s.pane === detail.pane : true)
      );
      if (match) void stopPvrSessionById(match.sessionId);
    };
    window.addEventListener(PVR_STOP_REQUEST_EVENT, onStop);
    return () => window.removeEventListener(PVR_STOP_REQUEST_EVENT, onStop);
  }, [stopPvrSessionById]);

  const handleGoToPvrChannel = useCallback(
    (channelId: string, pane: "L" | "R") => {
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return;
      if (!splitView) {
        setPrimaryActiveChannel(ch);
        return;
      }
      if (pane === "L") setPrimaryActiveChannel(ch);
      else setRightActiveChannel(ch);
      setAssignTarget(pane === "R" ? "R" : "L");
    },
    [channels, setPrimaryActiveChannel, setRightActiveChannel, splitView]
  );

  const backgroundPvrRecordingChannelIds = useMemo(
    () => pvrSessions.filter((s) => s.status === "recording").map((s) => s.channelId),
    [pvrSessions]
  );

  const pvrPlayerProps = {
    backgroundPvrRecordingChannelIds,
    onRequestStartPvr: handleRequestStartPvr,
    onRequestStopPvr: stopPvrSessionById,
    getChannelPvrSession: (channelId: string | null | undefined) =>
      channelId ? findPvrSessionForChannel(pvrSessions, channelId) : null,
  } as const;

  const recordingActive =
    recordingPanes.L || recordingPanes.R || pvrSessions.some((s) => s.status === "recording");
  const recordingChannelIds = useMemo(() => {
    const ids = new Set<string>();
    if (recordingPaneMeta.L?.channelId) ids.add(recordingPaneMeta.L.channelId);
    if (recordingPaneMeta.R?.channelId) ids.add(recordingPaneMeta.R.channelId);
    for (const s of pvrSessions) ids.add(s.channelId);
    return [...ids];
  }, [recordingPaneMeta, pvrSessions]);
  const recordingStatusLabel = useMemo(() => {
    const parts: string[] = [];
    if (recordingPaneMeta.L) parts.push(recordingPaneMeta.L.channelName);
    if (recordingPaneMeta.R) parts.push(recordingPaneMeta.R.channelName);
    for (const s of pvrSessions) {
      if (!parts.includes(s.channelName)) parts.push(s.channelName);
    }
    return parts.length ? parts.join(" · ") : null;
  }, [recordingPaneMeta, pvrSessions]);

  const onSidebarResizerPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    sidebarDragRef.current = { startX: e.clientX, startW: sidebarWidthLive.current };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onSidebarResizerPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = sidebarDragRef.current;
    if (!d) return;
    setSidebarWidth(fitSidebarToViewport(d.startW + (e.clientX - d.startX)));
  }, []);

  const onSidebarResizerPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (sidebarDragRef.current) {
      sidebarDragRef.current = null;
      setSidebarWidth((w) => {
        const n = fitSidebarToViewport(w);
        saveUiSession({ sidebarWidthPx: n });
        return n;
      });
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const onSidebarResizerDoubleClick = useCallback(() => {
    const w = fitSidebarToViewport(400);
    setSidebarWidth(w);
    saveUiSession({ sidebarWidthPx: w });
  }, []);

  return (
    <div
      className={`app-shell${compactView ? " app-shell--compact" : ""}`}
      style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` } as CSSProperties}
    >
      {!compactView ? (
        <>
          <aside className="browser-pane">
            <ChannelBrowser
              channels={channels}
              activeLeftId={active?.id ?? null}
              activeRightId={splitView ? channelRight?.id ?? null : null}
              splitView={splitView}
              assignTarget={assignTarget}
              onAssignTargetChange={setAssignTarget}
              onSelectChannel={handleSelectChannel}
              onResetTelevisionStream={handleResetTelevisionStream}
              resetTelevisionStreamDisabled={!canResetTelevisionStream}
              onLoadM3U={onLoadM3U}
              onClearList={onClearList}
              onAddLocalVideoChannels={onAddLocalVideoChannels}
              onRemoveChannel={onRemoveChannel}
              favoriteUrls={favoriteUrls}
              onToggleFavoriteChannel={toggleFavoriteChannel}
              audioLibraryShuffle={audioLibraryShuffle}
              audioLibraryContinuous={audioLibraryContinuous}
              onAudioLibraryShuffleChange={setAudioLibraryShuffle}
              onAudioLibraryContinuousChange={setAudioLibraryContinuous}
              recordingActive={recordingActive}
              recordingChannelIds={recordingChannelIds}
              recordingStatusLabel={recordingStatusLabel}
              sidebarMode={sidebarMode}
              onSidebarModeChange={handleSidebarModeChange}
              onIndexedLibraryChannelsChange={handleIndexedLibraryChannelsChange}
              onLibraryCleared={handleLibraryCleared}
              onLibraryTrackRemoved={handleLibraryTrackRemoved}
              compactView={compactView}
              onCompactViewChange={setCompactView}
              onOpenSettings={openSettings}
              pvrActiveSessions={pvrSessions}
              pvrHistory={pvrHistory}
              onStopPvrJob={stopPvrSessionById}
              onGoToPvrChannel={handleGoToPvrChannel}
              onClearPvrHistory={() => {
                clearPvrHistory();
                refreshPvrHistory();
              }}
              pvrRecordDir={pvrRecordDir}
              onPvrRecordDirChange={handlePvrRecordDirChange}
            />
          </aside>
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize channel list"
            title="Drag to resize. Double-click to reset width."
            tabIndex={0}
            onPointerDown={onSidebarResizerPointerDown}
            onPointerMove={onSidebarResizerPointerMove}
            onPointerUp={onSidebarResizerPointerUp}
            onPointerCancel={onSidebarResizerPointerUp}
            onDoubleClick={onSidebarResizerDoubleClick}
          />
        </>
      ) : null}
      <main
        className={`player-pane${splitView ? " player-pane--split" : ""}${compactView ? " player-pane--compact" : ""}${
          showCompactReaderWithTv ? " player-pane--compact-dual" : ""
        }`}
      >
        <Suspense fallback={<PlayerLoadingFallback splitView={splitView} />}>
          {showCompactReaderWithTv ? (
            <>
              <section className="compact-tv-dock" aria-label="Television while reading">
                <VideoPlayer
                  channel={compactTvChannel}
                  volume={volumeLeft}
                  onVolumeChange={setVolumeLeft}
                  layoutMode="compactTvDock"
                  recordable={false}
                  playbackPane="L"
                  onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
                />
              </section>
              <section className="compact-reader-dock" aria-label="Ebook reader">
                <VideoPlayer
                  channel={active}
                  volume={volumeLeft}
                  onVolumeChange={setVolumeLeft}
                  layoutMode="compactReader"
                  playbackPane="L"
                  onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
                  onRecordingStatusChange={setPaneRecording}
                  {...pvrPlayerProps}
                />
              </section>
            </>
          ) : splitView ? (
            <div className="player-split">
              <VideoPlayer
                channel={active}
                volume={volumeLeft}
                onVolumeChange={setVolumeLeft}
                paneLabel="Screen 1"
                splitIsolateNetwork={splitView}
                streamProxyOrigin={splitView && streamProxyOrigins ? streamProxyOrigins[0] : undefined}
                playbackPane="L"
                inSplitView
                onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
                onRecordingStatusChange={setPaneRecording}
                {...pvrPlayerProps}
              />
              <VideoPlayer
                channel={channelRight}
                volume={volumeRight}
                onVolumeChange={setVolumeRight}
                paneLabel="Screen 2"
                splitIsolateNetwork={splitView}
                streamProxyOrigin={splitView && streamProxyOrigins ? streamProxyOrigins[1] : undefined}
                playbackPane="R"
                inSplitView
                onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
                onRecordingStatusChange={setPaneRecording}
                {...pvrPlayerProps}
              />
            </div>
          ) : (
            <VideoPlayer
              channel={active}
              volume={volumeLeft}
              onVolumeChange={setVolumeLeft}
              layoutMode={soloLayoutMode}
              playbackPane="L"
              onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
              onRecordingStatusChange={setPaneRecording}
              {...pvrPlayerProps}
            />
          )}
        </Suspense>
      </main>
      {compactView ? (
        <div className="compact-fab-row">
          <button
            type="button"
            className="compact-library-fab"
            onClick={() => setCompactView(false)}
            title="Show channel library"
            aria-label="Show channel library"
          >
            Library
          </button>
          {window.iptv?.getLyricsChatTranslateKeyStatus ? (
            <button
              type="button"
              className="compact-library-fab compact-settings-fab"
              onClick={openSettings}
              title="Settings — LLM API keys"
              aria-label="Settings"
            >
              Settings
            </button>
          ) : null}
        </div>
      ) : null}
      <AppSettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsWelcome(false);
          setSettingsReason(null);
        }}
        welcome={settingsWelcome}
        reason={settingsReason}
        onDismissWelcome={dismissLlmSetupPrompt}
      />
    </div>
  );
}
