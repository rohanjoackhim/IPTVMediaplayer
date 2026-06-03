import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Channel } from "../types";
import { fetchM3uPlaylist } from "../utils/fetchM3uPlaylist";
import { parseM3U } from "../utils/m3uParser";
import { favoriteKeyForChannel } from "../utils/favoritesStorage";
import { loadLastPlaylistUrl, saveLastPlaylistUrl } from "../utils/playlistSettingsStorage";
import { loadUiSession, saveUiSession, type AssignPanePersisted, type ListTabPersisted, type SidebarModePersisted } from "../utils/uiSessionStorage";
import { loadVideoResumeSeconds } from "../utils/localVideoResumeStorage";
import { mimeHintForLocalVideoFilename } from "../utils/localVideoMime";
import { LocalAudioPanel, type LocalAudioPanelHandle } from "./LocalAudioPanel";
import { RadioPanel } from "./RadioPanel";
import { PodcastPanel } from "./PodcastPanel";
import { PvrJobsPanel } from "./PvrJobsPanel";
import { PvrRecordDirBar } from "./PvrRecordDirBar";
import { formatPvrCountdown } from "../utils/pvrRecording";
import type { PvrManagedSession } from "../utils/pvrRecordingManager";
import { formatEpgClock } from "../utils/epgService";
import "./ChannelBrowser.css";

function pvrToolbarChipText(session: PvrManagedSession): string {
  const name = session.channelName.trim() || "Channel";
  const tag = session.label.trim() || "PVR";
  const max = 20;
  if (`${name} · ${tag}`.length <= max) return `${name} · ${tag}`;
  const tagPart = tag.length > 8 ? `${tag.slice(0, 7)}…` : tag;
  const nameMax = Math.max(5, max - tagPart.length - 3);
  const namePart = name.length > nameMax ? `${name.slice(0, nameMax - 1)}…` : name;
  return `${namePart} · ${tagPart}`;
}

function pvrToolbarChipTitle(session: PvrManagedSession, nowMs: number): string {
  const parts = [session.channelName, session.label, session.status];
  if (session.status === "scheduled") {
    parts.push(`starts in ${formatPvrCountdown(Math.max(0, session.startAtMs - nowMs))}`);
    parts.push(formatEpgClock(session.startAtMs));
  } else if (session.status === "recording") {
    parts.push(`${formatPvrCountdown(Math.max(0, session.stopAtMs - nowMs))} left`);
    parts.push(`until ${formatEpgClock(session.stopAtMs)}`);
  }
  return parts.join(" · ");
}

const ROW_H = 42;
const MOVIE_ROW_H = 64;
const OVERSCAN = 16;
const MEDIA_PLAYBACK_TOGGLE_EVENT = "iptv-media-playback-toggle";
const MEDIA_PLAYBACK_STATE_EVENT = "iptv-media-playback-state";

function buildXtreamM3uUrl(server: string, username: string, password: string): string {
  const base = server.trim().replace(/\/+$/, "");
  const url = new URL(base.includes("://") ? base : `http://${base}`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/get.php`;
  url.search = "";
  url.searchParams.set("username", username.trim());
  url.searchParams.set("password", password);
  url.searchParams.set("type", "m3u_plus");
  url.searchParams.set("output", "ts");
  return url.toString();
}

/** Extract series name from episode name by removing season/episode patterns like "S01 E01", "S01E01", etc. */
function extractSeriesName(episodeName: string): string {
  const name = episodeName.trim();
  // Common patterns: "S01 E01", "S01E01", "Season 1 Episode 1", "1x01", "(2023) S01E01", etc.
  const patterns = [
    /\s+S\d{1,2}\s*E\d{1,2}\b/i,           // " S01 E01" or " S01E01"
    /\s+Season\s+\d+\s+Episode\s+\d+/i,   // " Season 1 Episode 1"
    /\s+\d{1,2}x\d{1,2}\b/,                // " 1x01"
    /\s*\(?\d{4}\)?\s+S\d{1,2}E\d{1,2}/i, // "(2023) S01E01" or "2023 S01E01"
    /\s+EP?\d{1,3}\b/i,                    // " E01" or " EP01" at end
  ];
  let result = name;
  for (const pattern of patterns) {
    result = result.replace(pattern, "");
  }
  // Clean up trailing punctuation and whitespace
  result = result.replace(/[\s\-_:,.]+$/, "").trim();
  return result || name; // fallback to original if empty
}

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
  assignTarget: AssignPanePersisted;
  onAssignTargetChange: (t: AssignPanePersisted) => void;
  onSelectChannel: (c: Channel) => void;
  onResetTelevisionStream: () => void;
  resetTelevisionStreamDisabled: boolean;
  onLoadM3U: (text: string, replace: boolean) => boolean;
  onClearList: () => void;
  /** Television: append channels for disk / browser-picked video files (split view with IPTV). */
  onAddLocalVideoChannels: (channels: Channel[]) => void;
  onRemoveChannel: (channelId: string) => void;
  favoriteUrls: Set<string>;
  onToggleFavoriteChannel: (c: Channel) => void;
  /** Local library: shuffle order when auto-advancing after a track ends. */
  audioLibraryShuffle: boolean;
  /** Local library: play the next track when the current one ends. */
  audioLibraryContinuous: boolean;
  onAudioLibraryShuffleChange: (v: boolean) => void;
  onAudioLibraryContinuousChange: (v: boolean) => void;
  recordingActive: boolean;
  /** Channel ids with an active background recording (may differ from the channel currently playing). */
  recordingChannelIds?: string[];
  /** Human-readable label for the Television tab recording indicator tooltip. */
  recordingStatusLabel?: string | null;
  sidebarMode: SidebarModePersisted;
  onSidebarModeChange: (mode: SidebarModePersisted) => void;
  /** Sidebar IndexedDB library tracks in list order (blob URLs) for auto-advance / shuffle. */
  onIndexedLibraryChannelsChange?: (channels: Channel[]) => void;
  /** Clear active player selection when the local audio library is emptied. */
  onLibraryCleared?: () => void;
  /** Clear active player selection when a single local audio track is removed. */
  onLibraryTrackRemoved?: (trackId: string) => void;
  compactView: boolean;
  onCompactViewChange: (enabled: boolean) => void;
  /** Open app Settings (LLM API keys). Desktop only. */
  onOpenSettings?: () => void;
  /** Active scheduled / recording PVR jobs. */
  pvrActiveSessions?: PvrManagedSession[];
  /** Finished or cancelled PVR jobs (with file paths when available). */
  pvrHistory?: PvrManagedSession[];
  onStopPvrJob?: (sessionId: string) => void;
  onGoToPvrChannel?: (channelId: string, pane: "L" | "R") => void;
  onClearPvrHistory?: () => void;
  /** Folder where scheduled / active PVR jobs save MP4 files. */
  pvrRecordDir?: string | null;
  onPvrRecordDirChange?: (dir: string | null) => void;
}

type ListTab = ListTabPersisted;
type RadioSectionTab = "stations" | "podcasts";

interface ApiChannelsPanelProps {
  apiChannelsList: Channel[];
  apiChannelsKey: string;
  apiChannelsKeyInput: string;
  apiChannelsLoading: boolean;
  apiChannelsError: string | null;
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
  favoriteUrls: Set<string>;
  onKeyInputChange: (v: string) => void;
  onLoad: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear: () => void;
  onSelectChannel: (ch: Channel) => void;
  onToggleFavorite: (ch: Channel) => void;
}

function ApiChannelsPanel({
  apiChannelsList, apiChannelsKey, apiChannelsKeyInput, apiChannelsLoading,
  apiChannelsError, activeLeftId, activeRightId, splitView, favoriteUrls,
  onKeyInputChange, onLoad, onKeyDown, onClear, onSelectChannel, onToggleFavorite,
}: ApiChannelsPanelProps) {
  return (
    <div className="channel-scroll" style={{ display: "flex", flexDirection: "column", overflow: "auto" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #2a2a3a", background: "#141420" }}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Enter your API key to load channels</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ flex: 1, background: "#1e1e2e", border: "1px solid #3a3a4a", borderRadius: 4, padding: "5px 8px", color: "#e0e0e0", fontSize: 12, fontFamily: "monospace" }}
            placeholder="iptv_..."
            value={apiChannelsKeyInput || apiChannelsKey}
            onChange={(e) => onKeyInputChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="file-btn" style={{ whiteSpace: "nowrap" }} onClick={onLoad}>
            Load
          </button>
          {apiChannelsKey ? (
            <button type="button" className="file-btn" style={{ whiteSpace: "nowrap" }} onClick={onClear}>
              Clear
            </button>
          ) : null}
        </div>
        {apiChannelsError ? <div style={{ fontSize: 12, color: "#f87171", marginTop: 6 }}>{apiChannelsError}</div> : null}
        {apiChannelsLoading ? <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>Loading…</div> : null}
      </div>
      {apiChannelsList.length === 0 && !apiChannelsLoading ? (
        <div className="empty-state">
          {apiChannelsKey ? "No channels found for this API key." : "Enter an API key above and press Load."}
        </div>
      ) : (
        apiChannelsList.map((ch) => {
          const isActive = ch.id === activeLeftId || (splitView && ch.id === activeRightId);
          const leftOn = ch.id === activeLeftId;
          const rightOn = splitView && ch.id === activeRightId;
          const chFav = favoriteUrls.has(favoriteKeyForChannel(ch));
          const rowClass = ["channel-row", isActive ? "active" : "", leftOn ? "active--left" : "", rightOn ? "active--right" : ""].filter(Boolean).join(" ");
          return (
            <div key={ch.id} className={rowClass}>
              <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(ch)}>
                {ch.logo ? (
                  <img className="channel-logo" src={ch.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="channel-logo placeholder">{ch.contentType === "movie" ? "MOV" : "TV"}</span>
                )}
                <span className="channel-meta">
                  <span className="channel-name">{ch.name}</span>
                  <span className="channel-group">{ch.group ?? ""}</span>
                </span>
              </button>
              <div className="channel-row-actions">
                <button type="button" className="channel-play-btn" title="Play" onClick={(e) => { e.stopPropagation(); onSelectChannel(ch); }}>
                  {"\u25b6"}
                </button>
              </div>
              <button
                type="button"
                className={chFav ? "fav-btn fav-btn--on" : "fav-btn"}
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(ch); }}
                title={chFav ? "Remove from favorites" : "Add to favorites"}
                aria-pressed={chFav}
              >
                {chFav ? "\u2605" : "\u2606"}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}

interface SeriesEpisodeRow {
  id: number; season: number; episode: number; title: string;
  logo: string; plot: string; rating: string; ext: string; url: string;
}

function ChannelBrowserInner({
  channels,
  activeLeftId,
  activeRightId,
  splitView,
  assignTarget,
  onAssignTargetChange,
  onSelectChannel,
  onResetTelevisionStream,
  resetTelevisionStreamDisabled,
  onLoadM3U,
  onClearList,
  onAddLocalVideoChannels,
  onRemoveChannel,
  favoriteUrls,
  onToggleFavoriteChannel,
  audioLibraryShuffle,
  audioLibraryContinuous,
  onAudioLibraryShuffleChange,
  onAudioLibraryContinuousChange,
  recordingActive,
  recordingChannelIds = [],
  recordingStatusLabel,
  sidebarMode,
  onSidebarModeChange,
  onIndexedLibraryChannelsChange,
  onLibraryCleared,
  onLibraryTrackRemoved,
  compactView,
  onCompactViewChange,
  onOpenSettings,
  pvrActiveSessions = [],
  pvrHistory = [],
  onStopPvrJob,
  onGoToPvrChannel,
  onClearPvrHistory,
  pvrRecordDir = null,
  onPvrRecordDirChange,
}: ChannelBrowserProps) {
  const canPickPvrRecordDir = typeof window !== "undefined" && typeof window.iptv?.pickRecordDir === "function";
  const [playlistUrl, setPlaylistUrl] = useState(() => loadLastPlaylistUrl());
  const [webVideoUrl, setWebVideoUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [query, setQuery] = useState(() => loadUiSession().query);
  const [group, setGroup] = useState(() => loadUiSession().group);
  const [listTab, setListTab] = useState<ListTab>(() => loadUiSession().listTab);
  const [radioCountry, setRadioCountry] = useState(() => loadUiSession().radioCountry);
  const [podcastCountry, setPodcastCountry] = useState(() => loadUiSession().podcastCountry);
  const [podcastGenreId, setPodcastGenreId] = useState(() => loadUiSession().podcastGenreId);
  const [radioSectionTab, setRadioSectionTab] = useState<RadioSectionTab>("stations");
  const [tvToolsOpen, setTvToolsOpen] = useState(false);
  const [xtreamLoginOpen, setXtreamLoginOpen] = useState(false);
  const [xtreamServer, setXtreamServer] = useState(() => {
    try { return localStorage.getItem("iptv-xtream-server") ?? ""; } catch { return ""; }
  });
  const [xtreamUsername, setXtreamUsername] = useState(() => {
    try { return localStorage.getItem("iptv-xtream-username") ?? ""; } catch { return ""; }
  });
  const [xtreamPassword, setXtreamPassword] = useState(() => {
    try { return localStorage.getItem("iptv-xtream-password") ?? ""; } catch { return ""; }
  });
  const [pvrPanelOpen, setPvrPanelOpen] = useState(false);
  const [pvrLabelTick, setPvrLabelTick] = useState(0);

  // API Channels state
  const [apiChannelsList, setApiChannelsList] = useState<Channel[]>([]);
  const [apiChannelsKey, setApiChannelsKey] = useState(() => { try { return localStorage.getItem("iptv-api-channels-key") ?? ""; } catch { return ""; } });
  const [apiChannelsKeyInput, setApiChannelsKeyInput] = useState("");
  const [apiChannelsLoading, setApiChannelsLoading] = useState(false);
  const [apiChannelsError, setApiChannelsError] = useState<string | null>(null);

  const fetchApiChannels = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setApiChannelsLoading(true);
    setApiChannelsError(null);
    try {
      const res = await fetch("http://localhost:3001/api/channels/public", {
        headers: { "x-api-key": key.trim() },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Error ${res.status}`);
      }
      const data = await res.json();
      const rows: Channel[] = (data.channels ?? []).map((c: Record<string, unknown>) => ({
        id: `api-${c.id}`,
        name: String(c.name ?? ""),
        url: String(c.url ?? ""),
        logo: c.logo ? String(c.logo) : undefined,
        group: c.group ? String(c.group) : undefined,
        contentType: (c.content_type === "movie" ? "movie" : c.content_type === "series" ? "series" : "live") as "live" | "movie" | "series",
      }));
      setApiChannelsList(rows);
    } catch (e: unknown) {
      setApiChannelsError(e instanceof Error ? e.message : "Failed to load channels");
    } finally {
      setApiChannelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (apiChannelsKey) fetchApiChannels(apiChannelsKey);
  }, [apiChannelsKey, fetchApiChannels]);

  // My Library (server-hosted audio) state
  type AudioTab = "local" | "myLibrary";
  const [audioTab, setAudioTab] = useState<AudioTab>("local");
  const [myLibraryKey, setMyLibraryKey] = useState(() => { try { return localStorage.getItem("iptv-my-library-key") ?? ""; } catch { return ""; } });
  const [myLibraryKeyInput, setMyLibraryKeyInput] = useState("");
  const [myLibraryFiles, setMyLibraryFiles] = useState<Channel[]>([]);
  const [myLibraryLoading, setMyLibraryLoading] = useState(false);
  const [myLibraryError, setMyLibraryError] = useState<string | null>(null);

  const fetchMyLibrary = useCallback(async (key: string) => {
    if (!key.trim()) return;
    setMyLibraryLoading(true);
    setMyLibraryError(null);
    try {
      const res = await fetch("http://localhost:3001/api/media/library", {
        headers: { "x-api-key": key.trim() },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Error ${res.status}`);
      }
      const data = await res.json();
      const rows: Channel[] = (data.files ?? []).map((f: Record<string, unknown>) => ({
        id: `media-${f.id}`,
        name: String(f.title || f.original_name || ""),
        url: String(f.stream_url ?? ""),
        group: f.media_type === "audiobook" ? "Audiobooks" : "Music",
        libraryContentType: String(f.mime_type || "audio/mpeg"),
      }));
      setMyLibraryFiles(rows);
    } catch (e: unknown) {
      setMyLibraryError(e instanceof Error ? e.message : "Failed to load library");
    } finally {
      setMyLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (myLibraryKey) fetchMyLibrary(myLibraryKey);
  }, [myLibraryKey, fetchMyLibrary]);

  const [m3uLoadMessage, setM3uLoadMessage] = useState<string | null>(null);
  const [mediaPlaybackState, setMediaPlaybackState] = useState<{ channelId: string; paused: boolean } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const localVideoFileRef = useRef<HTMLInputElement>(null);
  const tvToolsRef = useRef<HTMLDivElement>(null);
  const pvrToolsRef = useRef<HTMLDivElement>(null);
  const pvrJobCount = pvrActiveSessions.length;
  const audioPanelRef = useRef<LocalAudioPanelHandle>(null);
  const groups = useGroups(channels);
  const [selectedSeriesName, setSelectedSeriesName] = useState<string | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);

  const hasDesktopVideoPick =
    typeof window !== "undefined" && typeof window.iptv?.pickLocalVideoFiles === "function";

  useEffect(() => {
    if (!groups.includes(group)) setGroup("All groups");
  }, [groups, group]);

  useEffect(() => {
    saveUiSession({ listTab, query, group, country: "All countries", sidebarMode, radioCountry, podcastCountry, podcastGenreId });
  }, [listTab, query, group, sidebarMode, radioCountry, podcastCountry, podcastGenreId]);

  useEffect(() => {
    if (!tvToolsOpen) return;
    const onDocMouseDown = (ev: Event) => {
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (tvToolsRef.current?.contains(target)) return;
      setTvToolsOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setTvToolsOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tvToolsOpen]);

  useEffect(() => {
    if (!pvrPanelOpen) return;
    const onDocMouseDown = (ev: Event) => {
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (pvrToolsRef.current?.contains(target)) return;
      setPvrPanelOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setPvrPanelOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pvrPanelOpen]);

  useEffect(() => {
    if (!pvrActiveSessions.length) return;
    const id = window.setInterval(() => setPvrLabelTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [pvrActiveSessions.length]);
  void pvrLabelTick;

  const toggleFavorite = useCallback(
    (c: Channel, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onToggleFavoriteChannel(c);
    },
    [onToggleFavoriteChannel]
  );

  const isFavorite = useCallback((c: Channel) => favoriteUrls.has(favoriteKeyForChannel(c)), [favoriteUrls]);

  useEffect(() => {
    const onPlaybackState = (ev: Event) => {
      const detail = (ev as CustomEvent<{ channelId?: string; paused?: boolean }>).detail;
      if (!detail?.channelId || typeof detail.paused !== "boolean") return;
      setMediaPlaybackState({ channelId: detail.channelId, paused: detail.paused });
    };
    window.addEventListener(MEDIA_PLAYBACK_STATE_EVENT, onPlaybackState);
    return () => window.removeEventListener(MEDIA_PLAYBACK_STATE_EVENT, onPlaybackState);
  }, []);

  const toggleMediaPlayback = useCallback(
    (c: Channel, active: boolean, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!active) {
        onSelectChannel(c);
        return;
      }
      if (c.youtubeVideoId || c.webVideoPageUrl) return;
      window.dispatchEvent(new CustomEvent(MEDIA_PLAYBACK_TOGGLE_EVENT, { detail: { channelId: c.id } }));
    },
    [onSelectChannel]
  );

  const removeChannel = useCallback(
    (c: Channel, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onRemoveChannel(c.id);
    },
    [onRemoveChannel]
  );

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
    if (listTab === "movies") {
      return channels.filter((c) => c.contentType === "movie");
    }
    if (listTab === "series") {
      return channels.filter((c) => c.contentType === "series");
    }
    /* "all" tab: show only live channels (exclude movies/series for cleaner view) */
    return channels.filter((c) => c.contentType !== "movie" && c.contentType !== "series");
  }, [channels, listTab, favoriteUrls]);

  const localVideosCount = useMemo(() => channels.filter((c) => !!c.localVideoFile).length, [channels]);
  const moviesCount = useMemo(() => channels.filter((c) => c.contentType === "movie").length, [channels]);
  const seriesCount = useMemo(() => channels.filter((c) => c.contentType === "series").length, [channels]);

  /* Favorite categories for organized display */
  const favoriteChannels = useMemo(() => {
    if (listTab !== "favorites") return [];
    return channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c)) && c.contentType !== "movie" && c.contentType !== "series");
  }, [channels, listTab, favoriteUrls]);
  const favoriteMovies = useMemo(() => {
    if (listTab !== "favorites") return [];
    return channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c)) && c.contentType === "movie");
  }, [channels, listTab, favoriteUrls]);
  const favoriteSeries = useMemo(() => {
    if (listTab !== "favorites") return [];
    return channels.filter((c) => favoriteUrls.has(favoriteKeyForChannel(c)) && c.contentType === "series");
  }, [channels, listTab, favoriteUrls]);

  /* Series drill-down: unique show entries from channel list */
  const seriesShows = useMemo(() => {
    if (listTab !== "series") return [];
    const map = new Map<string, { name: string; logo?: string; genre?: string; rating?: string; plot?: string; seriesId?: number; group?: string }>();
    for (const c of tabFiltered) {
      // Use seriesName if available (already clean), otherwise extract from episode name like "(Un)Well S01 E01"
      const rawName = c.seriesName?.trim() || c.name;
      const sn = extractSeriesName(rawName);
      const existing = map.get(sn);
      if (existing) {
        // If we already have this show but the new entry has a seriesId, update it
        if (!existing.seriesId && c.seriesId) {
          map.set(sn, { ...existing, seriesId: c.seriesId });
        }
        continue;
      }
      map.set(sn, { name: sn, logo: c.logo, genre: c.genre, rating: c.rating, plot: c.plot, seriesId: c.seriesId, group: c.group });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [tabFiltered, listTab]);

  /* Series show list filtered by search query and group */
  const seriesShowsFiltered = useMemo(() => {
    if (listTab !== "series" || selectedSeriesName) return [];
    const q = query.trim().toLowerCase();
    if (q) return seriesShows.filter((s) => s.name.toLowerCase().includes(q) || (s.genre?.toLowerCase().includes(q) ?? false));
    if (group !== "All groups") return seriesShows.filter((s) => s.group === group);
    return seriesShows;
  }, [seriesShows, listTab, selectedSeriesName, query, group]);

  /* Lazily-fetched episode data for the selected series */
  const [fetchedEpisodes, setFetchedEpisodes] = useState<SeriesEpisodeRow[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null);

  /* Seasons derived from fetched episodes */
  const seriesSeasons = useMemo(() => {
    const seasons = new Set<number>();
    for (const ep of fetchedEpisodes) seasons.add(ep.season);
    return Array.from(seasons).sort((a, b) => a - b);
  }, [fetchedEpisodes]);

  /* Episodes filtered by selected season */
  const seriesEpisodes = useMemo(() => {
    const eps = selectedSeason != null
      ? fetchedEpisodes.filter((ep) => ep.season === selectedSeason)
      : fetchedEpisodes;
    return eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }, [fetchedEpisodes, selectedSeason]);

  /* Fetch episodes when a show is selected */
  const selectSeriesShow = useCallback((showName: string, seriesId?: number) => {
    console.log("[Series] selectSeriesShow:", showName, "seriesId:", seriesId);
    setSelectedSeriesName(showName);
    setSelectedSeason(null);
    setFetchedEpisodes([]);
    setSelectedSeriesId(seriesId ?? null);
    if (!seriesId) {
      console.warn("[Series] No seriesId, cannot fetch episodes.");
      return;
    }
    const xtreamServer = localStorage.getItem("iptv-xtream-server") ?? "";
    const xtreamUsername = localStorage.getItem("iptv-xtream-username") ?? "";
    const xtreamPassword = localStorage.getItem("iptv-xtream-password") ?? "";
    console.log("[Series] Xtream credentials:", { server: xtreamServer?.slice(0, 40), username: xtreamUsername, hasIpc: !!window.iptv?.fetchSeriesEpisodes });
    if (!xtreamServer || !xtreamUsername || !window.iptv?.fetchSeriesEpisodes) {
      console.warn("[Series] Missing credentials or IPC not available.");
      return;
    }
    setEpisodesLoading(true);
    window.iptv.fetchSeriesEpisodes({ server: xtreamServer, username: xtreamUsername, password: xtreamPassword, seriesId })
      .then((r) => {
        console.log("[Series] Episodes fetched:", r?.episodes?.length ?? 0);
        setFetchedEpisodes(r?.episodes ?? []);
      })
      .catch((e) => {
        console.error("[Series] Fetch episodes failed:", e);
        setFetchedEpisodes([]);
      })
      .finally(() => {
        setEpisodesLoading(false);
      });
  }, []);

  /* Reset series drill-down when switching tabs */
  useEffect(() => {
    if (listTab !== "series") {
      setSelectedSeriesName(null);
      setSelectedSeason(null);
      setFetchedEpisodes([]);
      setSelectedSeriesId(null);
    }
  }, [listTab]);

  const filtered = useMemo(() => {
    if (listTab === "favorites") return tabFiltered;
    const q = query.trim().toLowerCase();
    return tabFiltered.filter((c) => {
      if (group !== "All groups" && (c.group?.trim() || "") !== group) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.group?.toLowerCase().includes(q) ?? false) ||
        (c.country?.toLowerCase().includes(q) ?? false) ||
        (c.genre?.toLowerCase().includes(q) ?? false) ||
        (c.seriesName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [tabFiltered, query, group, listTab]);

  const activeListLen = listTab === "series" && !selectedSeriesName ? seriesShowsFiltered.length : filtered.length;
  const currentRowH = listTab === "movies" ? MOVIE_ROW_H : listTab === "series" && !selectedSeriesName ? MOVIE_ROW_H : ROW_H;
  const totalH = activeListLen * currentRowH;

  const { start, end } = useMemo(() => {
    const el = scrollRef.current;
    const h = el?.clientHeight ?? 600;
    const rowH = listTab === "movies" ? MOVIE_ROW_H : listTab === "series" && !selectedSeriesName ? MOVIE_ROW_H : ROW_H;
    const startIdx = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
    const visible = Math.ceil(h / rowH) + OVERSCAN * 2;
    const endIdx = Math.min(activeListLen, startIdx + visible);
    return { start: startIdx, end: endIdx };
  }, [scrollTop, activeListLen, listTab, selectedSeriesName]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
    });
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current != null) window.cancelAnimationFrame(scrollRafRef.current);
    },
    []
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [query, group, channels.length, listTab]);

  const isPlaylistFileName = (name: string) => /\.(m3u8?|txt|ts)$/i.test(name.trim());

  const isBlockedMediaFileName = (name: string) => {
    const lower = name.toLowerCase();
    if (isPlaylistFileName(lower)) return false;
    if (/\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)$/i.test(lower)) return true;
    return /\.(mp4|webm|mkv|mov|m4v|ogv|avi|wmv|mpeg|mpg|mpe|mpv|m1v|m2v|divx|asf|wm)(\?|#|$)/i.test(
      lower
    );
  };

  const applyM3uText = useCallback(
    (text: string, replace: boolean, sourceLabel?: string) => {
      const preview = parseM3U(text);
      const ok = onLoadM3U(text, replace);
      if (!ok) {
        const hint = preview.errors[0] ?? "No channels found in that playlist.";
        setM3uLoadMessage(
          sourceLabel ? `${sourceLabel}: ${hint}` : hint
        );
        return;
      }
      setM3uLoadMessage(
        `Loaded ${preview.channels.length} channel${preview.channels.length === 1 ? "" : "s"}${
          sourceLabel ? ` from ${sourceLabel}` : ""
        }.`
      );
      setListTab("all");
      setQuery("");
      setGroup("All groups");
      setTvToolsOpen(false);
    },
    [onLoadM3U]
  );

  const readFile = (file: File) => {
    if (isBlockedMediaFileName(file.name)) {
      setM3uLoadMessage(
        `"${file.name}" looks like a media file, not an M3U playlist. Choose a .m3u / .m3u8 file (some providers use .ts for MPEG-TS playlists).`
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      if (!text.trim()) {
        setM3uLoadMessage("Playlist file is empty or could not be read.");
        return;
      }
      applyM3uText(text, false, file.name);
    };
    reader.onerror = () => {
      setM3uLoadMessage("Could not read that file.");
    };
    reader.readAsText(file, "UTF-8");
  };

  const pickM3uFromDisk = useCallback(() => {
    void (async () => {
      if (typeof window.iptv?.pickM3uPlaylistFile === "function") {
        try {
          const res = await window.iptv.pickM3uPlaylistFile();
          if (res.cancelled) return;
          if (!res.ok || !res.text?.trim()) {
            setM3uLoadMessage(res.error ?? "Could not read playlist file.");
            return;
          }
          applyM3uText(res.text, false, res.fileName ?? "playlist");
        } catch (e) {
          setM3uLoadMessage(e instanceof Error ? e.message : "Could not read playlist file.");
        }
        return;
      }
      fileRef.current?.click();
    })();
  }, [applyM3uText]);

  const loadPlaylistFromUrl = async (replace: boolean) => {
    const trimmed = playlistUrl.trim();
    if (!trimmed) return;
    setUrlBusy(true);
    setM3uLoadMessage("Channels are loading, please wait…");
    try {
      // Extract and persist Xtream credentials from get.php URL so series episode fetching works
      try {
        const parsed = new URL(trimmed);
        if (parsed.pathname.endsWith("/get.php")) {
          const u = parsed.searchParams.get("username");
          const p = parsed.searchParams.get("password");
          if (u && p) {
            const server = `${parsed.protocol}//${parsed.host}`;
            localStorage.setItem("iptv-xtream-server", server);
            localStorage.setItem("iptv-xtream-username", u);
            localStorage.setItem("iptv-xtream-password", p);
          }
        }
      } catch { /* not a valid URL, skip */ }
      const text = await fetchM3uPlaylist(trimmed);
      saveLastPlaylistUrl(trimmed);
      applyM3uText(text, replace, "URL");
    } catch (e) {
      setM3uLoadMessage(e instanceof Error ? e.message : "Could not load playlist from URL.");
    } finally {
      setUrlBusy(false);
    }
  };

  const addXtreamLogin = async () => {
    if (!xtreamServer.trim() || !xtreamUsername.trim() || !xtreamPassword) {
      setM3uLoadMessage("Xtream Login: server, username, and password are required.");
      return;
    }
    let url: string;
    try {
      url = buildXtreamM3uUrl(xtreamServer, xtreamUsername, xtreamPassword);
    } catch {
      setM3uLoadMessage("Xtream Login: enter a valid server URL.");
      return;
    }
    try {
      localStorage.setItem("iptv-xtream-server", xtreamServer.trim());
      localStorage.setItem("iptv-xtream-username", xtreamUsername.trim());
      localStorage.setItem("iptv-xtream-password", xtreamPassword);
    } catch { /* storage full or blocked */ }
    console.log("[Xtream] Built URL:", url);
    setPlaylistUrl(url);
    setUrlBusy(true);
    setM3uLoadMessage("Channels are loading, please wait…");
    try {
      const text = await fetchM3uPlaylist(url);
      console.log("[Xtream] Response length:", text.length, "starts:", text.slice(0, 120));
      saveLastPlaylistUrl(url);
      applyM3uText(text, false, "Xtream Login");
    } catch (e) {
      setM3uLoadMessage(e instanceof Error ? e.message : "Could not load Xtream playlist.");
    } finally {
      setUrlBusy(false);
    }
  };

  const addWebVideoUrl = () => {
    const row = webVideoChannelFromUrl(webVideoUrl);
    if (!row) return;
    onAddLocalVideoChannels([row]);
    setWebVideoUrl("");
    setListTab("all");
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
          <h1 className="browser-title">Player</h1>
          {onOpenSettings && window.iptv?.getLyricsChatTranslateKeyStatus ? (
            <button
              type="button"
              className="browser-settings-btn"
              onClick={onOpenSettings}
              title="Settings — LLM API keys (Gemini, DeepSeek, OpenAI)"
              aria-label="Settings"
            >
              Settings
            </button>
          ) : null}
          <button
            type="button"
            className={`compact-view-btn${compactView ? " compact-view-btn--active" : ""}`}
            onClick={() => onCompactViewChange(!compactView)}
            title={
              compactView
                ? "Exit compact layout — show channel library"
                : "Compact layout — hide library and maximize the reader; TV keeps playing while you read"
            }
            aria-pressed={compactView}
          >
            {compactView ? "Compact on" : "Compact"}
          </button>
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
            {recordingActive ? (
              <span
                className="source-tab-recording-dot"
                role="status"
                aria-label={
                  recordingStatusLabel
                    ? `Recording ${recordingStatusLabel} — switch channels freely while it saves`
                    : "Recording is active — switch channels freely while it saves"
                }
                title={
                  recordingStatusLabel
                    ? `Recording ${recordingStatusLabel}. Pick another channel to watch while recording continues.`
                    : "Recording in progress. Pick another channel to watch while recording continues."
                }
              />
            ) : null}
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
          <div className="tv-toolbar-block" ref={pvrToolsRef}>
            <div className="tv-toolbar-row">
              {pvrActiveSessions.length > 0 ? (
                <div className="pvr-toolbar-labels" role="list" aria-label="Active PVR jobs">
                  {pvrActiveSessions.map((s) => (
                    <button
                      key={s.sessionId}
                      type="button"
                      role="listitem"
                      className={`pvr-toolbar-label pvr-toolbar-label--${s.status}`}
                      title={pvrToolbarChipTitle(s, Date.now())}
                      onClick={() => onGoToPvrChannel?.(s.channelId, s.pane)}
                    >
                      <span className="pvr-toolbar-label-dot" aria-hidden />
                      <span className="pvr-toolbar-label-text">{pvrToolbarChipText(s)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="tv-toolbar-row-end">
              <div className="pvr-tools-shell">
                <button
                  type="button"
                  className={`pvr-tools-toggle${pvrJobCount ? " pvr-tools-toggle--active" : ""}`}
                  aria-expanded={pvrPanelOpen}
                  aria-haspopup="dialog"
                  title="Scheduled and completed PVR recordings"
                  onClick={() => {
                    setPvrPanelOpen((open) => !open);
                    if (!pvrPanelOpen) setTvToolsOpen(false);
                  }}
                >
                  PVR
                  {pvrJobCount ? (
                    <span className="pvr-tools-badge" aria-label={`${pvrJobCount} active PVR jobs`}>
                      {pvrJobCount}
                    </span>
                  ) : null}
                </button>
              </div>
              <div className="tv-tools-shell" ref={tvToolsRef}>
              <button
                type="button"
                className="tv-tools-toggle"
                aria-expanded={tvToolsOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  setTvToolsOpen((open) => !open);
                  if (!tvToolsOpen) setPvrPanelOpen(false);
                }}
              >
                TV tools
              </button>
              {tvToolsOpen ? (
                <div className="tv-tools-popover" role="dialog" aria-label="Television tools">
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
              <button type="button" className="file-btn" onClick={() => pickM3uFromDisk()}>
                + Add M3U
              </button>
              <button
                type="button"
                className="file-btn"
                disabled={urlBusy}
                aria-expanded={xtreamLoginOpen}
                onClick={() => setXtreamLoginOpen((open) => !open)}
              >
                Xtream Login:
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
                </div>
                {m3uLoadMessage ? (
                  <p className="m3u-load-message" role="status">
                    {m3uLoadMessage}
                  </p>
                ) : null}
                {xtreamLoginOpen ? (
                  <div className="xtream-login-panel">
                    <input
                      className="playlist-url-input"
                      type="url"
                      inputMode="url"
                      placeholder="Server URL, e.g. http://provider.com:8080"
                      value={xtreamServer}
                      onChange={(e) => setXtreamServer(e.target.value)}
                      disabled={urlBusy}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Xtream server URL"
                    />
                    <input
                      className="playlist-url-input"
                      type="text"
                      placeholder="Username"
                      value={xtreamUsername}
                      onChange={(e) => setXtreamUsername(e.target.value)}
                      disabled={urlBusy}
                      autoComplete="username"
                      spellCheck={false}
                      aria-label="Xtream username"
                    />
                    <input
                      className="playlist-url-input"
                      type="password"
                      placeholder="Password"
                      value={xtreamPassword}
                      onChange={(e) => setXtreamPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void addXtreamLogin();
                      }}
                      disabled={urlBusy}
                      autoComplete="current-password"
                      aria-label="Xtream password"
                    />
                    <button type="button" className="url-btn" disabled={urlBusy} onClick={() => void addXtreamLogin()}>
                      Add Xtream channels
                    </button>
                  </div>
                ) : null}
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
              </div>
            ) : null}
              </div>
              </div>
            </div>
            {pvrPanelOpen ? (
              <div className="pvr-toolbar-panel" role="dialog" aria-label="PVR recordings">
                <div className="pvr-toolbar-panel-head">
                  <span className="pvr-toolbar-panel-title">PVR recordings</span>
                </div>
                <PvrRecordDirBar
                  recordDir={pvrRecordDir}
                  onRecordDirChange={(dir) => onPvrRecordDirChange?.(dir)}
                  canPickDir={canPickPvrRecordDir}
                />
                <PvrJobsPanel
                  activeSessions={pvrActiveSessions}
                  history={pvrHistory}
                  onStopJob={(id) => onStopPvrJob?.(id)}
                  onGoToChannel={(channelId, pane) => {
                    onGoToPvrChannel?.(channelId, pane);
                    setPvrPanelOpen(false);
                  }}
                  onRevealFile={
                    window.iptv?.showRecordInFolder
                      ? (filePath) => void window.iptv!.showRecordInFolder(filePath)
                      : undefined
                  }
                  onClearHistory={onClearPvrHistory}
                />
              </div>
            ) : null}
          </div>
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
            Live TV
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "favorites"}
            className={`browser-tab${listTab === "favorites" ? " active" : ""}`}
            onClick={() => {
              setQuery("");
              setGroup("All groups");
              setListTab("favorites");
            }}
          >
            Favorites{favoritesInLibrary > 0 ? ` (${favoritesInLibrary})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "movies"}
            className={`browser-tab${listTab === "movies" ? " active" : ""}`}
            onClick={() => { setQuery(""); setGroup("All groups"); setListTab("movies"); }}
          >
            Movies{moviesCount > 0 ? ` (${moviesCount})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "series"}
            className={`browser-tab${listTab === "series" ? " active" : ""}`}
            onClick={() => { setQuery(""); setGroup("All groups"); setListTab("series"); }}
          >
            Series{seriesCount > 0 ? ` (${seriesCount})` : ""}
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
          <button
            type="button"
            role="tab"
            aria-selected={listTab === "apiChannels"}
            className={`browser-tab${listTab === "apiChannels" ? " active" : ""}`}
            onClick={() => { setQuery(""); setListTab("apiChannels"); }}
          >
            API Channels{apiChannelsList.length > 0 ? ` (${apiChannelsList.length})` : ""}
          </button>
        </div>
      ) : sidebarMode === "radio" ? (
        <div className="browser-tabs" role="tablist" aria-label="Radio section">
          <button
            type="button"
            role="tab"
            aria-selected={radioSectionTab === "stations"}
            className={`browser-tab${radioSectionTab === "stations" ? " active" : ""}`}
            onClick={() => setRadioSectionTab("stations")}
          >
            Radio stations
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={radioSectionTab === "podcasts"}
            className={`browser-tab${radioSectionTab === "podcasts" ? " active" : ""}`}
            onClick={() => setRadioSectionTab("podcasts")}
          >
            Podcasts
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
            Screen 1
          </button>
          <button
            type="button"
            className={`assign-pane-btn${assignTarget === "R" ? " assign-pane-btn--on" : ""}`}
            onClick={() => onAssignTargetChange("R")}
            aria-pressed={assignTarget === "R"}
          >
            Screen 2
          </button>
        </div>
      ) : null}

      {sidebarMode === "tv" ? (
        <>
          {listTab === "apiChannels" ? (
            <ApiChannelsPanel
              apiChannelsList={apiChannelsList}
              apiChannelsKey={apiChannelsKey}
              apiChannelsKeyInput={apiChannelsKeyInput}
              apiChannelsLoading={apiChannelsLoading}
              apiChannelsError={apiChannelsError}
              activeLeftId={activeLeftId}
              activeRightId={activeRightId}
              splitView={splitView}
              favoriteUrls={favoriteUrls}
              onKeyInputChange={setApiChannelsKeyInput}
              onLoad={() => {
                const k = (apiChannelsKeyInput || apiChannelsKey).trim();
                if (!k) return;
                setApiChannelsKey(k);
                try { localStorage.setItem("iptv-api-channels-key", k); } catch { /* quota */ }
                void fetchApiChannels(k);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiChannelsKeyInput.trim()) {
                  const k = apiChannelsKeyInput.trim();
                  setApiChannelsKey(k);
                  try { localStorage.setItem("iptv-api-channels-key", k); } catch { /* quota */ }
                  void fetchApiChannels(k);
                }
              }}
              onClear={() => {
                setApiChannelsKey("");
                setApiChannelsKeyInput("");
                setApiChannelsList([]);
                setApiChannelsError(null);
                try { localStorage.removeItem("iptv-api-channels-key"); } catch { /* quota */ }
              }}
              onSelectChannel={onSelectChannel}
              onToggleFavorite={onToggleFavoriteChannel}
            />
          ) : listTab !== "favorites" ? (
          <div className="filters">
            <input
              className="search-input"
              placeholder={listTab === "localVideos" ? "Search local videos…" : listTab === "movies" ? "Search movies…" : listTab === "series" ? "Search series…" : "Search channels…"}
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
          ) : null}

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
                  if (!rows.length) return;
                  flushLocalVideoAdd(rows);
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
                        if (!rows.length) return;
                        flushLocalVideoAdd(rows);
                      } catch {
                        /* pick cancelled or failed */
                      }
                    })();
                  }}
                >
                  + Add local video
                </button>
              ) : null}
              {!hasDesktopVideoPick ? (
                <button type="button" className="file-btn" onClick={() => localVideoFileRef.current?.click()}>
                  + Add local video
                </button>
              ) : null}
            </div>
          ) : null}

          {/* --- Series drill-down view --- */}
          {listTab === "series" && selectedSeriesName ? (
            <div className="channel-scroll series-drilldown">
              <div className="series-drilldown-header">
                <button type="button" className="series-back-btn" onClick={() => { setSelectedSeriesName(null); setSelectedSeason(null); setFetchedEpisodes([]); }}>
                  ← All shows
                </button>
                <strong className="series-drilldown-title">{selectedSeriesName}</strong>
              </div>
              {seriesSeasons.length > 1 ? (
                <div className="series-season-tabs">
                  <button
                    type="button"
                    className={`series-season-btn${selectedSeason == null ? " active" : ""}`}
                    onClick={() => setSelectedSeason(null)}
                  >
                    All
                  </button>
                  {seriesSeasons.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`series-season-btn${selectedSeason === s ? " active" : ""}`}
                      onClick={() => setSelectedSeason(s)}
                    >
                      S{String(s).padStart(2, "0")}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="series-episode-list">
                {episodesLoading ? (
                  <div className="empty-state">Loading episodes…</div>
                ) : seriesEpisodes.length === 0 ? (
                  <div className="empty-state">No episodes found for this series.</div>
                ) : seriesEpisodes.map((ep) => {
                  const epChannelId = `series-ep-${selectedSeriesId}-${ep.season}-${ep.episode}`;
                  const epChannel: Channel = {
                    id: epChannelId,
                    name: `${selectedSeriesName} S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} - ${ep.title}`,
                    url: ep.url,
                    logo: ep.logo || undefined,
                    contentType: "series",
                    seriesName: selectedSeriesName ?? undefined,
                    seriesSeason: ep.season,
                    seriesEpisode: ep.episode,
                    episodeTitle: ep.title,
                    seriesId: selectedSeriesId ?? undefined,
                    containerExtension: ep.ext,
                  };
                  const active = epChannelId === activeLeftId || (splitView && epChannelId === activeRightId);
                  const leftOn = epChannelId === activeLeftId;
                  const rightOn = splitView && epChannelId === activeRightId;
                  const epPlayback = mediaPlaybackState?.channelId === epChannelId ? mediaPlaybackState : null;
                  const isPlaying = active && epPlayback?.paused !== true;
                  const isPaused = active && epPlayback?.paused === true;
                  const epFav = isFavorite(epChannel);
                  return (
                    <div key={epChannelId} className={`channel-row series-episode-row${active ? " active" : ""}${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}`}>
                      <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(epChannel)}>
                        {ep.logo ? (
                          <img className="channel-logo" src={ep.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <span className="channel-logo placeholder">EP</span>
                        )}
                        <span className="channel-meta">
                          <span className="channel-name">
                            {selectedSeriesName} S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")} - {ep.title}
                          </span>
                          <span className="channel-group">
                            {ep.rating ? <span>Rating: {ep.rating}</span> : null}
                          </span>
                        </span>
                      </button>
                      <div className="channel-row-actions" aria-label="Playback">
                        <button
                          type="button"
                          className={`channel-play-btn${isPaused ? " channel-play-btn--paused" : ""}`}
                          title={isPlaying ? "Pause" : isPaused ? "Resume" : "Play"}
                          aria-label={isPlaying ? `Pause ${ep.title}` : isPaused ? `Resume ${ep.title}` : `Play ${ep.title}`}
                          onClick={(e) => toggleMediaPlayback(epChannel, active, e)}
                        >
                          {isPlaying ? "Ⅱ" : "▶"}
                        </button>
                        <button
                          type="button"
                          className="channel-remove-btn"
                          title="Remove from list"
                          aria-label={`Remove ${ep.title}`}
                          onClick={(e) => removeChannel(epChannel, e)}
                        >
                          ×
                        </button>
                      </div>
                      <button
                        type="button"
                        className={`fav-btn${epFav ? " fav-btn--on" : ""}`}
                        onClick={(e) => toggleFavorite(epChannel, e)}
                        title={epFav ? "Remove from favorites" : "Add to favorites"}
                        aria-label={epFav ? `Remove ${ep.title} from favorites` : `Add ${ep.title} to favorites`}
                        aria-pressed={epFav}
                      >
                        {epFav ? "★" : "☆"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : listTab === "series" && !selectedSeriesName ? (
            <div className="channel-scroll series-show-list" ref={scrollRef} onScroll={onScroll}>
              {seriesShowsFiltered.length === 0 ? (
                <div className="empty-state">No series found. Load an Xtream playlist to see series here.</div>
              ) : (
                <div className="channel-scroll-inner" style={{ height: seriesShowsFiltered.length * MOVIE_ROW_H }}>
                  {seriesShowsFiltered.slice(start, end).map((show, i) => {
                    const top = (start + i) * MOVIE_ROW_H;
                    // Create a synthetic channel for favorite tracking
                    const showChannelKey = `series-show:${show.name}`;
                    const showAsChannel: Channel = {
                      id: showChannelKey,
                      name: show.name,
                      url: show.seriesId ? `series://${show.seriesId}` : showChannelKey,
                      logo: show.logo,
                      group: show.group,
                      genre: show.genre,
                      rating: show.rating,
                      contentType: "series",
                    };
                    const showFav = isFavorite(showAsChannel);
                    return (
                      <div key={show.name} className="channel-row series-show-row channel-row--movie" style={{ transform: `translateY(${top}px)` }} onClick={() => selectSeriesShow(show.name, show.seriesId)}>
                        <button type="button" className="channel-row-hit">
                          {show.logo ? (
                            <img className="channel-logo" src={show.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span className="channel-logo placeholder">TV</span>
                          )}
                          <span className="channel-meta">
                            <span className="channel-name">{show.name}</span>
                            <span className="channel-group">
                              {show.genre ? <span>{show.genre}</span> : null}
                              {show.genre && show.rating ? <span className="channel-sep"> · </span> : null}
                              {show.rating ? <span>Rating: {show.rating}</span> : null}
                            </span>
                          </span>
                        </button>
                        <div className="channel-row-actions">
                          <span className="series-arrow">→</span>
                        </div>
                        <button
                          type="button"
                          className={`fav-btn${showFav ? " fav-btn--on" : ""}`}
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(showAsChannel, e); }}
                          title={showFav ? "Remove from favorites" : "Add to favorites"}
                          aria-label={showFav ? `Remove ${show.name} from favorites` : `Add ${show.name} to favorites`}
                          aria-pressed={showFav}
                        >
                          {showFav ? "★" : "☆"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
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
                    <>No favorites in the current playlist match this view.</>
                  )
                ) : listTab === "localVideos" ? (
                  localVideosCount === 0 ? (
                    <>
                      No local videos yet. Use <strong>+ Add local video</strong> above. Playback position is saved per
                      file in this browser.
                    </>
                  ) : (
                    <>No local videos match your search. Try clearing the search box.</>
                  )
                ) : listTab === "movies" ? (
                  <>No movies found. Load an Xtream playlist to see movies here.</>
                ) : (
                  <>
                    No channels match your filters. Load an M3U playlist (IPTV providers usually give you a URL or file
                    with hundreds of <code>#EXTINF</code> entries).
                  </>
                )}
              </div>
            ) : (
              listTab === "favorites" ? (
                <div className="channel-scroll-inner favorites-sectioned">
                  {/* TV Channels Section */}
                  {favoriteChannels.length > 0 && (
                    <div className="favorites-section">
                      <div className="favorites-section-heading">TV Channels</div>
                      {favoriteChannels.map((c) => {
                        const fav = true;
                        const isRecordingChannel = recordingChannelIds.includes(c.id);
                        const leftOn = c.id === activeLeftId;
                        const rightOn = splitView && c.id === activeRightId;
                        const active = leftOn || rightOn;
                        const playback = mediaPlaybackState?.channelId === c.id ? mediaPlaybackState : null;
                        const isPlaying = active && playback?.paused !== true;
                        const isPaused = active && playback?.paused === true;
                        const embeddedPlayback = !!(c.youtubeVideoId || c.webVideoPageUrl);
                        const rowClass =
                          active
                            ? `channel-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}${
                                isRecordingChannel ? " channel-row--recording" : ""
                              }`
                            : isRecordingChannel
                              ? "channel-row channel-row--recording"
                              : "channel-row";
                        return (
                          <div key={c.id} className={rowClass}>
                            <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(c)}>
                              {c.logo ? (
                                <img className="channel-logo" src={c.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                              ) : (
                                <span className="channel-logo placeholder">TV</span>
                              )}
                              <span className="channel-meta">
                                <span className="channel-name">{c.name}</span>
                                {c.group || c.country ? (
                                  <span className="channel-group">
                                    {c.country ? <span className="channel-country">{c.country}</span> : null}
                                    {c.country && c.group ? <span className="channel-sep"> · </span> : null}
                                    {c.group ? <span>{c.group}</span> : null}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                            <div className="channel-row-actions" aria-label="Playback">
                              {isRecordingChannel ? <span className="channel-rec-badge" title="PVR or background recording on this channel" aria-label="Recording">REC</span> : null}
                              <button type="button" className={`channel-play-btn${isPaused ? " channel-play-btn--paused" : ""}`} title={embeddedPlayback && active ? "Use the embedded player controls" : isPlaying ? "Pause" : isPaused ? "Resume" : "Play"} aria-label={embeddedPlayback && active ? `${c.name} uses embedded player controls` : isPlaying ? `Pause ${c.name}` : isPaused ? `Resume ${c.name}` : `Play ${c.name}`} disabled={embeddedPlayback && active} onClick={(e) => toggleMediaPlayback(c, active, e)}>{isPlaying ? "Ⅱ" : "▶"}</button>
                            </div>
                            <button type="button" className={`fav-btn${fav ? " fav-btn--on" : ""}`} onClick={(e) => toggleFavorite(c, e)} title="Remove from favorites" aria-label={`Remove ${c.name} from favorites`} aria-pressed={fav}>★</button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Movies Section */}
                  {favoriteMovies.length > 0 && (
                    <div className="favorites-section">
                      <div className="favorites-section-heading">Movies</div>
                      {favoriteMovies.map((c) => {
                        const fav = true;
                        const isRecordingChannel = recordingChannelIds.includes(c.id);
                        const leftOn = c.id === activeLeftId;
                        const rightOn = splitView && c.id === activeRightId;
                        const active = leftOn || rightOn;
                        const playback = mediaPlaybackState?.channelId === c.id ? mediaPlaybackState : null;
                        const isPlaying = active && playback?.paused !== true;
                        const isPaused = active && playback?.paused === true;
                        const embeddedPlayback = !!(c.youtubeVideoId || c.webVideoPageUrl);
                        const rowClass =
                          active
                            ? `channel-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}${
                                isRecordingChannel ? " channel-row--recording" : ""
                              } channel-row--movie`
                            : isRecordingChannel
                              ? "channel-row channel-row--recording channel-row--movie"
                              : "channel-row channel-row--movie";
                        return (
                          <div key={c.id} className={rowClass}>
                            <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(c)}>
                              {c.logo ? (
                                <img className="channel-logo" src={c.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                              ) : (
                                <span className="channel-logo placeholder">▶</span>
                              )}
                              <span className="channel-meta">
                                <span className="channel-name">{c.name}</span>
                                <span className="channel-group">
                                  {c.genre ? <span>{c.genre}</span> : null}
                                  {c.genre && c.releaseYear ? <span className="channel-sep"> · </span> : null}
                                  {c.releaseYear ? <span>{c.releaseYear}</span> : null}
                                  {(c.genre || c.releaseYear) && c.rating ? <span className="channel-sep"> · </span> : null}
                                  {c.rating ? <span>Rating: {c.rating}</span> : null}
                                  {!c.genre && !c.releaseYear && !c.rating && c.group ? <span>{c.group}</span> : null}
                                </span>
                              </span>
                            </button>
                            <div className="channel-row-actions" aria-label="Playback">
                              {isRecordingChannel ? <span className="channel-rec-badge" title="PVR or background recording on this channel" aria-label="Recording">REC</span> : null}
                              <button type="button" className={`channel-play-btn${isPaused ? " channel-play-btn--paused" : ""}`} title={embeddedPlayback && active ? "Use the embedded player controls" : isPlaying ? "Pause" : isPaused ? "Resume" : "Play"} aria-label={embeddedPlayback && active ? `${c.name} uses embedded player controls` : isPlaying ? `Pause ${c.name}` : isPaused ? `Resume ${c.name}` : `Play ${c.name}`} disabled={embeddedPlayback && active} onClick={(e) => toggleMediaPlayback(c, active, e)}>{isPlaying ? "Ⅱ" : "▶"}</button>
                            </div>
                            <button type="button" className={`fav-btn${fav ? " fav-btn--on" : ""}`} onClick={(e) => toggleFavorite(c, e)} title="Remove from favorites" aria-label={`Remove ${c.name} from favorites`} aria-pressed={fav}>★</button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Series Section */}
                  {favoriteSeries.length > 0 && (
                    <div className="favorites-section">
                      <div className="favorites-section-heading">Series</div>
                      {favoriteSeries.map((c) => {
                        const fav = true;
                        const isRecordingChannel = recordingChannelIds.includes(c.id);
                        const leftOn = c.id === activeLeftId;
                        const rightOn = splitView && c.id === activeRightId;
                        const active = leftOn || rightOn;
                        const playback = mediaPlaybackState?.channelId === c.id ? mediaPlaybackState : null;
                        const isPlaying = active && playback?.paused !== true;
                        const isPaused = active && playback?.paused === true;
                        const rowClass =
                          active
                            ? `channel-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}${
                                isRecordingChannel ? " channel-row--recording" : ""
                              }`
                            : isRecordingChannel
                              ? "channel-row channel-row--recording"
                              : "channel-row";
                        return (
                          <div key={c.id} className={rowClass}>
                            <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(c)}>
                              {c.logo ? (
                                <img className="channel-logo" src={c.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                              ) : (
                                <span className="channel-logo placeholder">TV</span>
                              )}
                              <span className="channel-meta">
                                <span className="channel-name">{c.name}</span>
                                {c.group || c.seriesName ? (
                                  <span className="channel-group">
                                    {c.seriesName ? <span>{c.seriesName}</span> : null}
                                    {c.seriesName && c.group ? <span className="channel-sep"> · </span> : null}
                                    {c.group ? <span>{c.group}</span> : null}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                            <div className="channel-row-actions" aria-label="Playback">
                              {isRecordingChannel ? <span className="channel-rec-badge" title="PVR or background recording on this channel" aria-label="Recording">REC</span> : null}
                              <button type="button" className={`channel-play-btn${isPaused ? " channel-play-btn--paused" : ""}`} title={isPlaying ? "Pause" : isPaused ? "Resume" : "Play"} aria-label={isPlaying ? `Pause ${c.name}` : isPaused ? `Resume ${c.name}` : `Play ${c.name}`} onClick={(e) => toggleMediaPlayback(c, active, e)}>{isPlaying ? "Ⅱ" : "▶"}</button>
                            </div>
                            <button type="button" className={`fav-btn${fav ? " fav-btn--on" : ""}`} onClick={(e) => toggleFavorite(c, e)} title="Remove from favorites" aria-label={`Remove ${c.name} from favorites`} aria-pressed={fav}>★</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="channel-scroll-inner" style={{ height: totalH }}>
                {filtered.slice(start, end).map((c, i) => {
                  const index = start + i;
                  const isMovie = c.contentType === "movie";
                  const top = index * (isMovie ? MOVIE_ROW_H : ROW_H);
                  const fav = isFavorite(c);
                  const isRecordingChannel = recordingChannelIds.includes(c.id);
                  const leftOn = c.id === activeLeftId;
                  const rightOn = splitView && c.id === activeRightId;
                  const active = leftOn || rightOn;
                  const playback = mediaPlaybackState?.channelId === c.id ? mediaPlaybackState : null;
                  const isPlaying = active && playback?.paused !== true;
                  const isPaused = active && playback?.paused === true;
                  const embeddedPlayback = !!(c.youtubeVideoId || c.webVideoPageUrl);
                  const rowClass =
                    active
                      ? `channel-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}${
                          isRecordingChannel ? " channel-row--recording" : ""
                        }${isMovie ? " channel-row--movie" : ""}`
                      : isRecordingChannel
                        ? `channel-row channel-row--recording${isMovie ? " channel-row--movie" : ""}`
                        : `channel-row${isMovie ? " channel-row--movie" : ""}`;
                  return (
                    <div key={c.id} className={rowClass} style={{ transform: `translateY(${top}px)` }}>
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
                          ) : c.contentType === "movie" ? (
                            <span className="channel-group">
                              {c.genre ? <span>{c.genre}</span> : null}
                              {c.genre && c.releaseYear ? <span className="channel-sep"> · </span> : null}
                              {c.releaseYear ? <span>{c.releaseYear}</span> : null}
                              {(c.genre || c.releaseYear) && c.rating ? <span className="channel-sep"> · </span> : null}
                              {c.rating ? <span>Rating: {c.rating}</span> : null}
                              {!c.genre && !c.releaseYear && !c.rating && c.group ? <span>{c.group}</span> : null}
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
                      <div className="channel-row-actions" aria-label="Playback">
                        {isRecordingChannel ? (
                          <span
                            className="channel-rec-badge"
                            title="PVR or background recording on this channel"
                            aria-label="Recording"
                          >
                            REC
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={`channel-play-btn${isPaused ? " channel-play-btn--paused" : ""}`}
                          title={
                            embeddedPlayback && active
                              ? "Use the embedded player controls"
                              : isPlaying
                                ? "Pause"
                                : isPaused
                                  ? "Resume"
                                  : "Play"
                          }
                          aria-label={
                            embeddedPlayback && active
                              ? `${c.name} uses embedded player controls`
                              : isPlaying
                                ? `Pause ${c.name}`
                                : isPaused
                                  ? `Resume ${c.name}`
                                  : `Play ${c.name}`
                          }
                          disabled={embeddedPlayback && active}
                          onClick={(e) => toggleMediaPlayback(c, active, e)}
                        >
                          {isPlaying ? "Ⅱ" : "▶"}
                        </button>
                        <button
                          type="button"
                          className="channel-remove-btn"
                          title="Remove from list"
                          aria-label={`Remove ${c.name}`}
                          onClick={(e) => removeChannel(c, e)}
                        >
                          ×
                        </button>
                      </div>
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
            ))}
          </div>
          )}
        </>
      ) : null}
      {sidebarMode === "radio" && radioSectionTab === "stations" ? (
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
      {sidebarMode === "radio" && radioSectionTab === "podcasts" ? (
        <PodcastPanel
          onSelectEpisode={onSelectChannel}
          activeLeftId={activeLeftId}
          activeRightId={activeRightId}
          splitView={splitView}
          favoriteUrls={favoriteUrls}
          onToggleFavoriteChannel={onToggleFavoriteChannel}
          podcastCountry={podcastCountry}
          onPodcastCountryChange={setPodcastCountry}
          podcastGenreId={podcastGenreId}
          onPodcastGenreChange={setPodcastGenreId}
        />
      ) : null}
      {/*
        Keep local audio mounted when switching Television / Radio so blob: URLs for the library list are not
        recreated while the right player still references an earlier object URL for the same track id.
      */}
      <div
        className={`browser-local-audio-host${sidebarMode === "audio" ? " browser-local-audio-host--visible" : ""}`}
        aria-hidden={sidebarMode !== "audio"}
        style={{ flexDirection: "column", overflow: "hidden" }}
      >
        {/* Audio sub-tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid #2a2a3a", background: "#0f0f16", flexShrink: 0 }}>
          <button
            type="button"
            role="tab"
            aria-selected={audioTab === "local"}
            className={`browser-tab${audioTab === "local" ? " active" : ""}`}
            style={{ flex: 1 }}
            onClick={() => setAudioTab("local")}
          >
            Local Library
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={audioTab === "myLibrary"}
            className={`browser-tab${audioTab === "myLibrary" ? " active" : ""}`}
            style={{ flex: 1 }}
            onClick={() => setAudioTab("myLibrary")}
          >
            My Library{myLibraryFiles.length > 0 ? ` (${myLibraryFiles.length})` : ""}
          </button>
        </div>

        {/* Local library (always mounted) */}
        <div style={{ display: audioTab === "local" ? "flex" : "none", flexDirection: "column", flex: 1, overflow: "hidden" }}>
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
            onLibraryCleared={onLibraryCleared}
            onLibraryTrackRemoved={onLibraryTrackRemoved}
            onOpenSettings={onOpenSettings}
          />
        </div>

        {/* My Library — server-hosted audio via API key */}
        {audioTab === "myLibrary" ? (
          <div className="channel-scroll" style={{ display: "flex", flexDirection: "column", overflow: "auto", flex: 1 }}>
            <div style={{ padding: "10px 12px", borderBottom: "1px solid #2a2a3a", background: "#141420", flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Enter your API key to stream your uploaded music &amp; audiobooks</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  style={{ flex: 1, background: "#1e1e2e", border: "1px solid #3a3a4a", borderRadius: 4, padding: "5px 8px", color: "#e0e0e0", fontSize: 12, fontFamily: "monospace" }}
                  placeholder="iptv_..."
                  value={myLibraryKeyInput || myLibraryKey}
                  onChange={(e) => setMyLibraryKeyInput(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === "Enter" && myLibraryKeyInput.trim()) {
                      const k = myLibraryKeyInput.trim();
                      setMyLibraryKey(k);
                      try { localStorage.setItem("iptv-my-library-key", k); } catch { /* quota */ }
                      void fetchMyLibrary(k);
                    }
                  }}
                />
                <button
                  type="button"
                  className="file-btn"
                  style={{ whiteSpace: "nowrap" }}
                  onClick={() => {
                    const k = (myLibraryKeyInput || myLibraryKey).trim();
                    if (!k) return;
                    setMyLibraryKey(k);
                    try { localStorage.setItem("iptv-my-library-key", k); } catch { /* quota */ }
                    void fetchMyLibrary(k);
                  }}
                >
                  Load
                </button>
                {myLibraryKey ? (
                  <button
                    type="button"
                    className="file-btn"
                    style={{ whiteSpace: "nowrap" }}
                    onClick={() => {
                      setMyLibraryKey("");
                      setMyLibraryKeyInput("");
                      setMyLibraryFiles([]);
                      setMyLibraryError(null);
                      try { localStorage.removeItem("iptv-my-library-key"); } catch { /* quota */ }
                    }}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              {myLibraryError ? <div style={{ fontSize: 12, color: "#f87171", marginTop: 6 }}>{myLibraryError}</div> : null}
              {myLibraryLoading ? <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>Loading…</div> : null}
            </div>
            {myLibraryFiles.length === 0 && !myLibraryLoading ? (
              <div className="empty-state">
                {myLibraryKey ? "No files in your library yet. Upload audio files via the portal." : "Enter your API key above and press Load."}
              </div>
            ) : (
              myLibraryFiles.map((ch) => {
                const isActive = ch.id === activeLeftId || (splitView && ch.id === activeRightId);
                const rowClass = ["channel-row", isActive ? "active" : ""].filter(Boolean).join(" ");
                return (
                  <div key={ch.id} className={rowClass}>
                    <button type="button" className="channel-row-hit" onClick={() => onSelectChannel(ch)}>
                      <span className="channel-logo placeholder" style={{ fontSize: 12 }}>{ch.group === "Audiobooks" ? "📖" : "🎵"}</span>
                      <span className="channel-meta">
                        <span className="channel-name">{ch.name}</span>
                        <span className="channel-group">{ch.group ?? "Music"}</span>
                      </span>
                    </button>
                    <div className="channel-row-actions">
                      <button
                        type="button"
                        className="channel-play-btn"
                        title="Play"
                        onClick={(e) => { e.stopPropagation(); onSelectChannel(ch); }}
                      >
                        {"\u25b6"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const ChannelBrowser = memo(ChannelBrowserInner);
