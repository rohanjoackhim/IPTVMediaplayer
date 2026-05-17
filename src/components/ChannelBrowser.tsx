import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Channel } from "../types";
import { fetchM3uPlaylist } from "../utils/fetchM3uPlaylist";
import { favoriteKeyForChannel } from "../utils/favoritesStorage";
import { loadLastPlaylistUrl, saveLastPlaylistUrl } from "../utils/playlistSettingsStorage";
import { loadUiSession, saveUiSession, type AssignPanePersisted, type ListTabPersisted, type SidebarModePersisted } from "../utils/uiSessionStorage";
import { loadVideoResumeSeconds } from "../utils/localVideoResumeStorage";
import { mimeHintForLocalVideoFilename } from "../utils/localVideoMime";
import { LocalAudioPanel, type LocalAudioPanelHandle } from "./LocalAudioPanel";
import { RadioPanel } from "./RadioPanel";
import "./ChannelBrowser.css";

const ROW_H = 52;
const OVERSCAN = 12;

function normalizeDesktopLocalVideoRows(raw: unknown): Channel[] {
  if (!Array.isArray(raw)) return [];
  const out: Channel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : "";
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "Video";
    const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : "";
    if (!id || !url) continue;
    const mime = typeof o.mime === "string" && o.mime.trim() ? o.mime.trim() : undefined;
    const originalFileName = typeof o.originalFileName === "string" ? o.originalFileName.trim() : "";
    out.push({
      id,
      name,
      url,
      group: "Local video",
      localVideoFile: true,
      libraryContentType: mime,
      localOriginalFileName: originalFileName || undefined,
    });
  }
  return out;
}

function channelsFromBrowserVideoFiles(list: FileList | null): Channel[] {
  if (!list?.length) return [];
  const out: Channel[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || f.size === 0) continue;
    const url = URL.createObjectURL(f);
    const stripped = f.name.replace(/\.[^./]+$/, "");
    const name = stripped.trim() || f.name;
    const hint = mimeHintForLocalVideoFilename(f.name);
    let mime: string | undefined = hint;
    const ft = f.type?.trim();
    if (ft && ft !== "application/octet-stream") mime = ft;
    out.push({
      id: `local-video-web-${crypto.randomUUID()}`,
      name,
      url,
      group: "Local video",
      localVideoFile: true,
      libraryContentType: mime,
      localOriginalFileName: f.name,
    });
  }
  return out;
}

function youtubeVideoIdFromUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v") ?? "";
      if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      const embedIdx = parts.findIndex((p) => p === "embed" || p === "shorts" || p === "live");
      const id = embedIdx >= 0 ? parts[embedIdx + 1] ?? "" : "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
  } catch {
    /* invalid URL */
  }
  return null;
}

function isLikelyDirectPlayableVideoUrl(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return /\.(m3u8|mp4|m4v|webm|ogv|mov|mpeg|mpg|mpe|mpv|m1v|m2v|m2ts|mts|ts)(\?|#|$)/i.test(s);
}

function webVideoNameFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./i, "");
    const pathName = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "")
      .replace(/\.[^/.]+$/, "")
      .replace(/[-_]+/g, " ")
      .trim();
    return pathName ? `${host} - ${pathName}` : host || "Web video";
  } catch {
    return "Web video";
  }
}

function webVideoChannelFromUrl(raw: string): Channel | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const id = youtubeVideoIdFromUrl(raw);
  if (!id && !isLikelyDirectPlayableVideoUrl(trimmed)) {
    try {
      new URL(trimmed);
    } catch {
      return null;
    }
  }
  if (!id && isLikelyDirectPlayableVideoUrl(trimmed)) {
    return {
      id: `web-video-direct-${crypto.randomUUID()}`,
      name: webVideoNameFromUrl(trimmed),
      url: trimmed,
      group: "Web video",
    };
  }
  if (!id) {
    return {
      id: `web-video-page-${crypto.randomUUID()}`,
      name: webVideoNameFromUrl(trimmed),
      url: trimmed,
      group: "Web video",
      webVideoPageUrl: trimmed,
    };
  }
  return {
    id: `youtube-${id}-${crypto.randomUUID()}`,
    name: `YouTube ${id}`,
    url: trimmed,
    group: "Web video",
    youtubeVideoId: id,
  };
}

function formatVideoResume(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function useGroups(channels: Channel[]) {
  return useMemo(() => {
    const s = new Set<string>();
    for (const c of channels) {
      if (c.group?.trim()) s.add(c.group.trim());
    }
    return ["All groups", ...Array.from(s).sort((a, b) => a.localeCompare(b))];
  }, [channels]);
}

export interface ChannelBrowserProps {
  channels: Channel[];
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
  onSplitViewChange: (v: boolean) => void;
  assignTarget: AssignPanePersisted;
  onAssignTargetChange: (t: AssignPanePersisted) => void;
  onSelectChannel: (c: Channel) => void;
  onResetTelevisionStream: () => void;
  resetTelevisionStreamDisabled: boolean;
  onLoadM3U: (text: string, replace: boolean) => void;
  onClearList: () => void;
  /** Television: append channels for disk / browser-picked video files (split view with IPTV). */
  onAddLocalVideoChannels: (channels: Channel[]) => void;
  parseMessage: string | null;
  onPlaylistMessage: (message: string | null) => void;
  favoriteUrls: Set<string>;
  onToggleFavoriteChannel: (c: Channel) => void;
  /** Local library: shuffle order when auto-advancing after a track ends. */
  audioLibraryShuffle: boolean;
  /** Local library: play the next track when the current one ends. */
  audioLibraryContinuous: boolean;
  onAudioLibraryShuffleChange: (v: boolean) => void;
  onAudioLibraryContinuousChange: (v: boolean) => void;
  sidebarMode: SidebarModePersisted;
  onSidebarModeChange: (mode: SidebarModePersisted) => void;
  /** Sidebar IndexedDB library tracks in list order (blob URLs) for auto-advance / shuffle. */
  onIndexedLibraryChannelsChange?: (channels: Channel[]) => void;
}

type ListTab = ListTabPersisted;

function ChannelBrowserInner({
  channels,
  activeLeftId,
  activeRightId,
  splitView,
  onSplitViewChange,
  assignTarget,
  onAssignTargetChange,
  onSelectChannel,
  onResetTelevisionStream,
  resetTelevisionStreamDisabled,
  onLoadM3U,
  onClearList,
  onAddLocalVideoChannels,
  parseMessage,
  onPlaylistMessage,
  favoriteUrls,
  onToggleFavoriteChannel,
  audioLibraryShuffle,
  audioLibraryContinuous,
  onAudioLibraryShuffleChange,
  onAudioLibraryContinuousChange,
  sidebarMode,
  onSidebarModeChange,
  onIndexedLibraryChannelsChange,
}: ChannelBrowserProps) {
  const [playlistUrl, setPlaylistUrl] = useState(() => loadLastPlaylistUrl());
  const [webVideoUrl, setWebVideoUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [query, setQuery] = useState(() => loadUiSession().query);
  const [group, setGroup] = useState(() => loadUiSession().group);
  const [listTab, setListTab] = useState<ListTab>(() => loadUiSession().listTab);
  const [radioCountry, setRadioCountry] = useState(() => loadUiSession().radioCountry);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const localVideoFileRef = useRef<HTMLInputElement>(null);
  const audioPanelRef = useRef<LocalAudioPanelHandle>(null);
  const groups = useGroups(channels);

  const hasDesktopVideoPick =
    typeof window !== "undefined" && typeof window.iptv?.pickLocalVideoFiles === "function";

  useEffect(() => {
    if (!groups.includes(group)) setGroup("All groups");
  }, [groups, group]);

  useEffect(() => {
    saveUiSession({ listTab, query, group, country: "All countries", sidebarMode, radioCountry });
  }, [listTab, query, group, sidebarMode, radioCountry]);

  const toggleFavorite = useCallback(
    (c: Channel, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onToggleFavoriteChannel(c);
    },
    [onToggleFavoriteChannel]
  );

  const isFavorite = useCallback((c: Channel) => favoriteUrls.has(favoriteKeyForChannel(c)), [favoriteUrls]);

  const flushLocalVideoAdd = useCallback(
    (rows: Channel[]) => {
      if (!rows.length) return;
      onAddLocalVideoChannels(rows);
      setListTab("localVideos");
    },
    [onAddLocalVideoChannels]
  );

  const tabFiltered = useMemo(() => {
    if (listTab === "favorites") {
      return channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c)));
    }
    if (listTab === "localVideos") {
      return channels.filter((c) => !!c.localVideoFile);
    }
    return channels;
  }, [channels, listTab, favoriteUrls]);

  const localVideosCount = useMemo(() => channels.filter((c) => !!c.localVideoFile).length, [channels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tabFiltered.filter((c) => {
      if (group !== "All groups" && (c.group?.trim() || "") !== group) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.group?.toLowerCase().includes(q) ?? false) ||
        (c.country?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [tabFiltered, query, group]);

  const totalH = filtered.length * ROW_H;

  const { start, end } = useMemo(() => {
    const el = scrollRef.current;
    const h = el?.clientHeight ?? 600;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const visible = Math.ceil(h / ROW_H) + OVERSCAN * 2;
    const endIdx = Math.min(filtered.length, startIdx + visible);
    return { start: startIdx, end: endIdx };
  }, [scrollTop, filtered.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [query, group, channels.length, listTab]);

  const readFile = (file: File) => {
    const lower = file.name.toLowerCase();
    if (
      /\.(mp4|webm|mkv|mov|m4v|ogv|avi|wmv|mpeg|mpg|mpe|mpv|m1v|m2v|m2ts|mts|ts|divx|asf|wm)(\?|$)/i.test(
        lower
      )
    ) {
      onPlaylistMessage(
        "That file is a video, not an M3U playlist. Use + Add local video (or Add local video via browser) in the Television toolbar."
      );
      return;
    }
    if (/\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm)$/.test(lower)) {
      onPlaylistMessage(
        "That file is audio, not an M3U playlist. Open the Audio tab and add files there (desktop: Add files…)."
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      onLoadM3U(text, false);
    };
    reader.readAsText(file, "UTF-8");
  };

  const loadPlaylistFromUrl = async (replace: boolean) => {
    const trimmed = playlistUrl.trim();
    if (!trimmed) {
      onPlaylistMessage("Enter an M3U or M3U8 playlist URL (https://…).");
      return;
    }
    onPlaylistMessage("Loading playlist from URL…");
    setUrlBusy(true);
    try {
      const text = await fetchM3uPlaylist(trimmed);
      saveLastPlaylistUrl(trimmed);
      onLoadM3U(text, replace);
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : "Could not load playlist from URL. In production builds, the server must allow CORS or use a file.";
      onPlaylistMessage(msg);
    } finally {
      setUrlBusy(false);
    }
  };

  const addWebVideoUrl = () => {
    const row = webVideoChannelFromUrl(webVideoUrl);
    if (!row) {
      onPlaylistMessage("Enter a valid http(s) video URL or website page that contains video.");
      return;
    }
    onAddLocalVideoChannels([row]);
    setWebVideoUrl("");
    setListTab("all");
    onPlaylistMessage(
      row.webVideoPageUrl
        ? "Added web video page to Television. Some websites block embedded playback."
        : "Added web video to Television."
    );
  };

  const favCount = favoriteUrls.size;

  const favoritesInLibrary = useMemo(
    () => channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c))).length,
    [channels, favoriteUrls]
  );

  return (
    <div className="browser-root">
      <header className="browser-header">
        <div className="browser-header-row">
          <h1 className="browser-title">Smart Media player</h1>
        </div>
        <div className="source-tabs" role="tablist" aria-label="Library">
          <button
            type="button"
            role="tab"
            aria-selected={sidebarMode === "tv"}
            className={`source-tab${sidebarMode === "tv" ? " active" : ""}`}
            onClick={() => onSidebarModeChange("tv")}
          >
            <span className="source-tab-glyph" aria-hidden>
              📺
            </span>
            Television
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarMode === "radio"}
            className={`source-tab${sidebarMode === "radio" ? " active" : ""}`}
            onClick={() => onSidebarModeChange("radio")}
          >
            <span className="source-tab-glyph" aria-hidden>
              📻
            </span>
            Radio
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarMode === "audio"}
            className={`source-tab${sidebarMode === "audio" ? " active" : ""}`}
            onClick={() => onSidebarModeChange("audio")}
          >
            <span className="source-tab-glyph" aria-hidden>
              ♪
            </span>
            Audio
          </button>
        </div>
        {sidebarMode === "tv" ? (
          <>
            <div className="toolbar">
              <input
                ref={fileRef}
                type="file"
                accept=".m3u,.m3u8,text/plain"
                className="hidden-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) readFile(f);
                  e.target.value = "";
                }}
              />
              <button type="button" className="file-btn" onClick={() => fileRef.current?.click()}>
                + Add M3U
              </button>
              <button type="button" className="btn-ghost" onClick={onClearList}>
                Clear list
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={resetTelevisionStreamDisabled}
                title="Reconnect the selected stream locally. This does not bypass provider access rules or change your IP."
                onClick={onResetTelevisionStream}
              >
                Reset stream
              </button>
              <label className="split-toggle">
                <input
                  type="checkbox"
                  checked={splitView}
                  onChange={(e) => onSplitViewChange(e.target.checked)}
                />
                Split view (2 players)
              </label>
            </div>
            <div className="url-row">
              <input
                className="playlist-url-input"
                type="url"
                inputMode="url"
                placeholder="https://example.com/playlist.m3u"
                value={playlistUrl}
                onChange={(e) => setPlaylistUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void loadPlaylistFromUrl(e.shiftKey);
                }}
                autoComplete="off"
                spellCheck={false}
                disabled={urlBusy}
                aria-label="M3U playlist URL"
              />
              <button
                type="button"
                className="url-btn"
                disabled={urlBusy}
                onClick={() => void loadPlaylistFromUrl(false)}
              >
                Add from URL
              </button>
              <button
                type="button"
                className="url-btn"
                disabled={urlBusy}
                onClick={() => void loadPlaylistFromUrl(true)}
              >
                Refresh channels
              </button>
            </div>
            <div className="url-row">
              <input
                className="playlist-url-input"
                type="url"
                inputMode="url"
                placeholder="Paste a video page or direct video URL"
                value={webVideoUrl}
                onChange={(e) => setWebVideoUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addWebVideoUrl();
                }}
                autoComplete="off"
                spellCheck={false}
                aria-label="Web video URL"
              />
              <button type="button" className="url-btn" onClick={addWebVideoUrl}>
                Add web video
              </button>
            </div>
            {parseMessage ? <div className="message-bar">{parseMessage}</div> : null}
          </>
        ) : sidebarMode === "radio" ? (
          <p className="browser-sub browser-sub--radio">
            Online stations by country (Radio Browser). Use <strong>Television</strong> to load M3U playlists and IPTV
            channels. Favorites (★) work for both TV and radio streams.
          </p>
        ) : sidebarMode === "audio" ? (
          <p className="browser-sub browser-sub--radio">
            Local audio: on desktop use <strong>Add files…</strong> for reliable loading; the library is stored in
            IndexedDB. Playback resumes on the <strong>right</strong> player. <strong>⇄</strong> shuffle and{" "}
            <strong>⟳</strong> continuous play sit in the row with the add buttons. Use <strong>Television</strong> for M3U
            playlists and IPTV channels.
          </p>
        ) : null}
      </header>

      {sidebarMode === "tv" ? (
        <div className="browser-tabs" role="tablist" aria-label="Channel list">
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "all"}
            className={`browser-tab${listTab === "all" ? " active" : ""}`}
            onClick={() => setListTab("all")}
          >
            All channels
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "favorites"}
            className={`browser-tab${listTab === "favorites" ? " active" : ""}`}
            onClick={() => setListTab("favorites")}
          >
            Favorites{favoritesInLibrary > 0 ? ` (${favoritesInLibrary})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "localVideos"}
            className={`browser-tab${listTab === "localVideos" ? " active" : ""}`}
            onClick={() => setListTab("localVideos")}
          >
            Local videos{localVideosCount > 0 ? ` (${localVideosCount})` : ""}
          </button>
        </div>
      ) : null}

      {splitView && sidebarMode !== "audio" ? (
        <div className="assign-pane-row" role="radiogroup" aria-label="Which player receives the next channel click">
          <span className="assign-pane-label">Next click plays on:</span>
          <button
            type="button"
            className={`assign-pane-btn${assignTarget === "L" ? " assign-pane-btn--on" : ""}`}
            onClick={() => onAssignTargetChange("L")}
            aria-pressed={assignTarget === "L"}
          >
            Left
          </button>
          <button
            type="button"
            className={`assign-pane-btn${assignTarget === "R" ? " assign-pane-btn--on" : ""}`}
            onClick={() => onAssignTargetChange("R")}
            aria-pressed={assignTarget === "R"}
          >
            Right
          </button>
        </div>
      ) : null}

      {sidebarMode === "tv" ? (
        <>
          <div className="filters">
            <input
              className="search-input"
              placeholder={listTab === "localVideos" ? "Search local videos…" : "Search channels…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {listTab !== "localVideos" ? (
              <div className="filter-selects">
                <select className="group-select" value={group} onChange={(e) => setGroup(e.target.value)}>
                  {groups.map((g) => (
                    <option key={g} value={g}>
                      {g === "All groups" ? "All groups" : `Group: ${g}`}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          {listTab === "localVideos" ? (
            <div className="local-videos-toolbar" role="region" aria-label="Local video files">
              <input
                ref={localVideoFileRef}
                type="file"
                accept="video/*,.mp4,.webm,.mkv,.mov,.m4v,.ogv,.avi,.wmv,.mpeg,.mpg,.mpe,.mpv,.m1v,.m2v,.m2ts,.mts,.ts,.divx,.asf,.wm"
                className="hidden-input"
                multiple
                onChange={(e) => {
                  const list = e.target.files;
                  e.target.value = "";
                  const rows = channelsFromBrowserVideoFiles(list);
                  if (!rows.length) {
                    onPlaylistMessage("No video files were selected (or files were empty).");
                    return;
                  }
                  flushLocalVideoAdd(rows);
                  onPlaylistMessage(null);
                }}
              />
              {hasDesktopVideoPick ? (
                <button
                  type="button"
                  className="file-btn"
                  onClick={() => {
                    void (async () => {
                      try {
                        const raw = await window.iptv!.pickLocalVideoFiles();
                        const rows = normalizeDesktopLocalVideoRows(raw);
                        if (!rows.length) {
                          onPlaylistMessage("No video files were added (empty selection or unreadable files).");
                          return;
                        }
                        flushLocalVideoAdd(rows);
                        onPlaylistMessage(null);
                      } catch (e) {
                        onPlaylistMessage(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                >
                  + Add local video
                </button>
              ) : null}
              <button type="button" className="file-btn" onClick={() => localVideoFileRef.current?.click()}>
                {hasDesktopVideoPick ? "+ Add local video (browser)" : "+ Add local video"}
              </button>
              <p className="local-videos-toolbar-hint">
                Last played time is remembered per file (this browser). On the desktop app, <strong>.mkv</strong> files
                are converted to H.264/AAC MP4 on first play (FFmpeg; may take a while). Use split view and Next click
                plays on to play a file on one side while IPTV runs on the other.
              </p>
            </div>
          ) : null}

          <div className="channel-scroll" ref={scrollRef} onScroll={onScroll}>
            {filtered.length === 0 ? (
              <div className="empty-state">
                {listTab === "favorites" ? (
                  favoritesInLibrary === 0 ? (
                    favCount > 0 ? (
                      <>
                        You have <strong>{favCount}</strong> saved favorite{favCount === 1 ? "" : "s"}, but none match
                        the current playlist. Add your M3U or use <strong>Refresh channels</strong> to bring those
                        channels back, or open{" "}
                        <strong>All channels</strong> to star new ones.
                      </>
                    ) : (
                      <>
                        No favorites yet. Open <strong>All channels</strong> and click the <strong>★</strong> on a row
                        to add it here. Favorites are stored in this browser by stream URL.
                      </>
                    )
                  ) : (
                    <>
                      No favorites match your search or filters. Try clearing the search box or choosing{" "}
                      <strong>All groups</strong>.
                    </>
                  )
                ) : listTab === "localVideos" ? (
                  localVideosCount === 0 ? (
                    <>
                      No local videos yet. Use <strong>+ Add local video</strong> (desktop) or{" "}
                      <strong>+ Add local video (browser)</strong> above. Playback position is saved per file in this
                      browser.
                    </>
                  ) : (
                    <>No local videos match your search. Try clearing the search box.</>
                  )
                ) : (
                  <>
                    No channels match your filters. Load an M3U playlist (IPTV providers usually give you a URL or file
                    with hundreds of <code>#EXTINF</code> entries).
                  </>
                )}
              </div>
            ) : (
              <div className="channel-scroll-inner" style={{ height: totalH }}>
                {filtered.slice(start, end).map((c, i) => {
                  const index = start + i;
                  const top = index * ROW_H;
                  const fav = isFavorite(c);
                  const leftOn = c.id === activeLeftId;
                  const rightOn = splitView && c.id === activeRightId;
                  const rowClass =
                    leftOn || rightOn
                      ? `channel-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}`
                      : "channel-row";
                  return (
                    <div key={c.id} className={rowClass} style={{ top }}>
                      <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(c)}>
                        {c.logo ? (
                          <img
                            className="channel-logo"
                            src={c.logo}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : c.youtubeVideoId || c.webVideoPageUrl ? (
                          <span className="channel-logo placeholder" aria-hidden>
                            WEB
                          </span>
                        ) : c.localVideoFile ? (
                          <span className="channel-logo placeholder" aria-hidden>
                            ▶
                          </span>
                        ) : (
                          <span className="channel-logo placeholder">TV</span>
                        )}
                        <span className="channel-meta">
                          <span className="channel-name">{c.name}</span>
                          {c.youtubeVideoId || c.webVideoPageUrl ? (
                            <span className="channel-group">
                              <span>{c.youtubeVideoId ? "YouTube" : "Web video"}</span>
                              <span className="channel-sep"> · </span>
                              <span>{c.webVideoPageUrl ? "Embedded page" : "Embedded playback"}</span>
                            </span>
                          ) : c.localVideoFile ? (
                            <span className="channel-group">
                              <span>{c.group?.trim() || "Local video"}</span>
                              <span className="channel-sep"> · </span>
                              <span className="channel-local-video-resume">
                                {(() => {
                                  const rs = loadVideoResumeSeconds(c.id);
                                  return rs != null && rs >= 3
                                    ? `Resume at ${formatVideoResume(rs)}`
                                    : "Start from beginning";
                                })()}
                              </span>
                            </span>
                          ) : c.group || c.country ? (
                            <span className="channel-group">
                              {c.country ? <span className="channel-country">{c.country}</span> : null}
                              {c.country && c.group ? <span className="channel-sep"> · </span> : null}
                              {c.group ? <span>{c.group}</span> : null}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`fav-btn${fav ? " fav-btn--on" : ""}`}
                        onClick={(e) => toggleFavorite(c, e)}
                        title={fav ? "Remove from favorites" : "Add to favorites"}
                        aria-label={fav ? `Remove ${c.name} from favorites` : `Add ${c.name} to favorites`}
                        aria-pressed={fav}
                      >
                        ★
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : null}
      {sidebarMode === "radio" ? (
        <RadioPanel
          onSelectStation={onSelectChannel}
          activeLeftId={activeLeftId}
          activeRightId={activeRightId}
          splitView={splitView}
          favoriteUrls={favoriteUrls}
          onToggleFavoriteChannel={onToggleFavoriteChannel}
          radioCountry={radioCountry}
          onRadioCountryChange={setRadioCountry}
        />
      ) : null}
      {/*
        Keep local audio mounted when switching Television / Radio so blob: URLs for the library list are not
        recreated while the right player still references an earlier object URL for the same track id.
      */}
      <div
        className={`browser-local-audio-host${sidebarMode === "audio" ? " browser-local-audio-host--visible" : ""}`}
        aria-hidden={sidebarMode !== "audio"}
      >
        <LocalAudioPanel
          ref={audioPanelRef}
          onSelectTrack={onSelectChannel}
          activeLeftId={activeLeftId}
          activeRightId={activeRightId}
          splitView={splitView}
          onIndexedLibraryChannelsChange={onIndexedLibraryChannelsChange}
          audioLibraryShuffle={audioLibraryShuffle}
          audioLibraryContinuous={audioLibraryContinuous}
          onAudioLibraryShuffleChange={onAudioLibraryShuffleChange}
          onAudioLibraryContinuousChange={onAudioLibraryContinuousChange}
        />
      </div>
    </div>
  );
}

export const ChannelBrowser = memo(ChannelBrowserInner);
