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
import { ChannelBrowser } from "./components/ChannelBrowser";
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
import type { Channel } from "./types";

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

const PARSE_MESSAGE_KEY = "iptv-parse-message";

function loadParseMessage(): string | null {
  try {
    const s = localStorage.getItem(PARSE_MESSAGE_KEY);
    return s && s.trim() ? s : null;
  } catch {
    return null;
  }
}

function saveParseMessage(msg: string | null) {
  try {
    if (msg?.trim()) localStorage.setItem(PARSE_MESSAGE_KEY, msg.trim());
    else localStorage.removeItem(PARSE_MESSAGE_KEY);
  } catch {
    /* noop */
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
  const [splitView, setSplitView] = useState(false);
  const [assignTarget, setAssignTarget] = useState(() => loadUiSession().assignTarget);
  const [volumeLeft, setVolumeLeft] = useState(() => loadUiSession().volumeLeft);
  const [volumeRight, setVolumeRight] = useState(() => loadUiSession().volumeRight);
  const [parseMessage, setParseMessage] = useState<string | null>(() => loadParseMessage());
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(() => loadFavoriteUrls());
  const [audioLibraryShuffle, setAudioLibraryShuffle] = useState(() => loadUiSession().audioLibraryShuffle);
  const [audioLibraryContinuous, setAudioLibraryContinuous] = useState(
    () => loadUiSession().audioLibraryContinuous
  );
  const [sidebarMode, setSidebarMode] = useState(() => loadUiSession().sidebarMode);
  /** Electron: two localhost origins (different ports) so left/right streams do not share one connection pool. */
  const [streamProxyOrigins, setStreamProxyOrigins] = useState<[string, string] | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => fitSidebarToViewport(loadUiSession().sidebarWidthPx));
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const sidebarWidthLive = useRef(sidebarWidth);
  sidebarWidthLive.current = sidebarWidth;

  useEffect(() => {
    const fn = window.iptv?.getStreamProxyOrigins;
    if (!fn) return;
    void fn().then((list) => {
      if (!Array.isArray(list) || list.length < 2) return;
      const a = typeof list[0] === "string" ? list[0].trim() : "";
      const b = typeof list[1] === "string" ? list[1].trim() : "";
      if (a && b) setStreamProxyOrigins([a, b]);
    });
  }, [splitView]);

  useEffect(() => {
    saveParseMessage(parseMessage);
  }, [parseMessage]);

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

  /** Refetch last playlist URL on launch when one is saved (channels + favorites stay in local storage). */
  useEffect(() => {
    const url = loadLastPlaylistUrl();
    if (!url) return;
    let cancelled = false;
    void fetchM3uPlaylist(url)
      .then((text) => {
        if (cancelled) return;
        const { channels: next, errors } = parseM3U(text);
        if (next.length) {
          setChannels(next);
          setParseMessage(
            `Reloaded ${next.length} channel(s) from saved playlist URL.${errors.length ? " " + errors.join(" ") : ""}`
          );
        }
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

  const handleSelectChannel = useCallback(
    (c: Channel) => {
      if (c.ebookId) {
        setActive(c);
        return;
      }
      if (!splitView) {
        setActive(c);
        return;
      }
      if (assignTarget === "L") setActive(c);
      else setChannelRight(c);
    },
    [splitView, assignTarget]
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
      setChannelRight((cur) => bump(cur));
    } else {
      setActive((cur) => bump(cur));
    }
    setParseMessage("Reset local stream session for the selected player. Provider-side blocks still require a valid provider/account connection.");
  }, [assignTarget, splitView]);

  const onLoadM3U = useCallback((text: string, replace: boolean) => {
    const { channels: next, errors } = parseM3U(text);
    if (errors.length && next.length === 0) {
      setParseMessage(errors.join(" "));
      return;
    }
    setParseMessage(
      next.length ? `Loaded ${next.length} channel(s).${errors.length ? " " + errors.join(" ") : ""}` : null
    );
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
          if (byLast) return byLast;
        }
        return next[0] ?? null;
      }
      if (!cur && next.length) return next[0];
      return cur;
    });
  }, []);

  const onClearList = useCallback(() => {
    setChannels((prev) => {
      revokeLocalVideoBlobUrls(prev);
      return [];
    });
    setActive(null);
    setChannelRight(null);
    setParseMessage("Playlist cleared.");
  }, []);

  const onAddLocalVideoChannels = useCallback((incoming: Channel[]) => {
    if (!incoming.length) return;
    setChannels((prev) => [...incoming, ...prev]);
    const webVideoCount = incoming.filter((c) => !!c.youtubeVideoId || !!c.webVideoPageUrl).length;
    if (webVideoCount > 0) {
      setParseMessage(
        `Added ${webVideoCount} web video${webVideoCount === 1 ? "" : "s"} at the top of the Television list. Website pages play only when the site allows embedded playback.`
      );
      return;
    }
    setSplitView(true);
    setParseMessage(
      `Added ${incoming.length} local video file(s) at the top of the list (see the Local videos tab). Playback position is saved per file. Turn on Split view if it was off, then use Next click plays on to put IPTV on one player and a local file on the other.`
    );
  }, []);

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
        if (pane === "L") setActive(next);
        else setChannelRight(next);
      } else {
        setActive(next);
      }
    },
    [audioLibraryContinuous, audioLibraryShuffle, indexedLibraryChannels, libraryAudioChannels, splitView]
  );

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
      className="app-shell"
      style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` } as CSSProperties}
    >
      <aside className="browser-pane">
        <ChannelBrowser
          channels={channels}
          activeLeftId={active?.id ?? null}
          activeRightId={splitView ? channelRight?.id ?? null : null}
          splitView={splitView}
          onSplitViewChange={handleSplitViewChange}
          assignTarget={assignTarget}
          onAssignTargetChange={setAssignTarget}
          onSelectChannel={handleSelectChannel}
          onResetTelevisionStream={handleResetTelevisionStream}
          resetTelevisionStreamDisabled={!canResetTelevisionStream}
          onLoadM3U={onLoadM3U}
          onClearList={onClearList}
          onAddLocalVideoChannels={onAddLocalVideoChannels}
          parseMessage={parseMessage}
          onPlaylistMessage={setParseMessage}
          favoriteUrls={favoriteUrls}
          onToggleFavoriteChannel={toggleFavoriteChannel}
          audioLibraryShuffle={audioLibraryShuffle}
          audioLibraryContinuous={audioLibraryContinuous}
          onAudioLibraryShuffleChange={setAudioLibraryShuffle}
          onAudioLibraryContinuousChange={setAudioLibraryContinuous}
          sidebarMode={sidebarMode}
          onSidebarModeChange={setSidebarMode}
          onIndexedLibraryChannelsChange={handleIndexedLibraryChannelsChange}
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
      <main className={`player-pane${splitView ? " player-pane--split" : ""}`}>
        <Suspense fallback={<PlayerLoadingFallback splitView={splitView} />}>
          {splitView ? (
            <div className="player-split">
              <VideoPlayer
                key={`L-${active?.id ?? "none"}`}
                channel={active}
                volume={volumeLeft}
                onVolumeChange={setVolumeLeft}
                paneLabel="Left"
                splitIsolateNetwork={splitView}
                streamProxyOrigin={splitView && streamProxyOrigins ? streamProxyOrigins[0] : undefined}
                playbackPane="L"
                inSplitView
                onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
              />
              <VideoPlayer
                key={`R-${channelRight?.id ?? "none"}`}
                channel={channelRight}
                volume={volumeRight}
                onVolumeChange={setVolumeRight}
                paneLabel="Right"
                splitIsolateNetwork={splitView}
                streamProxyOrigin={splitView && streamProxyOrigins ? streamProxyOrigins[1] : undefined}
                playbackPane="R"
                inSplitView
                onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
              />
            </div>
          ) : (
            <VideoPlayer
              key={`S-${active?.id ?? "none"}`}
              channel={active}
              volume={volumeLeft}
              onVolumeChange={setVolumeLeft}
              playbackPane="L"
              onLocalLibraryAudioEnded={handleLocalLibraryAudioEnded}
            />
          )}
        </Suspense>
      </main>
    </div>
  );
}
