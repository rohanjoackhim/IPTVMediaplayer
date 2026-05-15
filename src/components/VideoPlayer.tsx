import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { flushSync } from "react-dom";
import Hls, { FetchLoader } from "hls.js";
import mpegts from "mpegts.js";
import type { Channel } from "../types";
import { isLikelyHls, isLikelyMpegTsOverHttp } from "../utils/streamKind";
import { mpegtsIptvConfig, streamRefererForUrl } from "../utils/iptvStreamHeaders";
import { isAlreadyProxiedStreamUrl, proxiedStreamUrl, shouldUseStreamProxy } from "../utils/proxiedStreamUrl";
import {
  canRecordRawHttpStream,
  isRadioStationChannelId,
  recordFileSuffixAndTapType,
} from "../utils/recordableStream";
import { formatBufferStatsLine, getBufferedAheadSec } from "../utils/mediaBufferedStats";
import { srtToWebVtt } from "../utils/srtToWebVtt";
import { clearAudioResume, loadAudioResumeSeconds, saveAudioResumeSeconds } from "../utils/audioResumeStorage";
import { clearVideoResume, loadVideoResumeSeconds, saveVideoResumeSeconds } from "../utils/localVideoResumeStorage";
import { mimeHintForLocalVideoUrl } from "../utils/localVideoMime";
import { getLibraryLyricsCache } from "../utils/audioLibraryDb";
import { isLikelyLocalMp3Channel, youtubeSearchQueryFromTrackName } from "../utils/youtubeSearchFromLocalTitle";
import {
  enrichLocalMp3LyricsWithSongMeaning,
  fetchBilingualLyricsForLocalMp3,
  mapCachedLibraryLyricsToResult,
  type LyricLinePair,
  type LocalMp3LyricsResult,
} from "../utils/localMp3LyricsPipeline";
import { createLyricsJsonFetcher } from "../utils/lyricsJsonFetch";
import { formatLlmUsageLine } from "../utils/lyricsLlmEndpointLabel";
import { labelForLyricsTargetCode } from "../utils/lyricsTargetLanguages";
import { translateLineBatchesToLanguage } from "../utils/translateLyricsLines";
import {
  resolveTrackMetadataFromLibrary,
  type TrackFileMetadata,
} from "../utils/resolveTrackMetadata";
import { LyricsTranslateMenu } from "./LyricsTranslateMenu";
import { RadioEqualizer } from "./RadioEqualizer";
import "./VideoPlayer.css";
import "./LyricsTranslateMenu.css";

function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    video.canPlayType("application/x-mpegURL") !== "";
}

export interface VideoPlayerProps {
  channel: Channel | null;
  /** 0 (mute) … 1 */
  volume?: number;
  onVolumeChange?: (v: number) => void;
  /** Shown in split layout (e.g. Left / Right). */
  paneLabel?: string;
  /** Show record-to-disk UI (default on). */
  recordable?: boolean;
  /** Split view (desktop): use a dedicated localhost port pool for this pane’s proxied streams. */
  streamProxyOrigin?: string | null;
  /** Split view: route HLS through the local proxy with FetchLoader so CDN requests do not share one browser connection cap. */
  splitIsolateNetwork?: boolean;
  /** Which player this instance is (for local library auto-advance). */
  playbackPane?: "L" | "R";
  /** Fires when a local IndexedDB library track (`blob:` + `libraryTrackId`) finishes naturally. */
  onLocalLibraryAudioEnded?: (info: { pane: "L" | "R"; channelId: string }) => void;
}

interface TrackOption {
  id: string;
  label: string;
  index: number;
}

type MpegtsPlayer = ReturnType<typeof mpegts.createPlayer>;

/** mpegts.js passes `extra` like `{ code: 502, msg: "Bad Gateway" }` for HttpStatusCodeInvalid. */
function mpegTsErrorHttpInfo(extra: unknown): { status?: number; msg?: string } {
  let status: number | undefined;
  let msg: string | undefined;
  if (extra != null && typeof extra === "object" && !Array.isArray(extra)) {
    const o = extra as Record<string, unknown>;
    const c = o.code;
    const m = o.msg;
    if (typeof c === "number" && Number.isFinite(c)) status = c;
    else if (typeof c === "string" && /^\d+$/.test(c)) status = Number(c);
    if (typeof m === "string") msg = m;
  }
  return { status, msg };
}

function mpegTsIsHttpStatusCodeError(detail: unknown): boolean {
  return String(detail ?? "").includes("HttpStatusCodeInvalid");
}

function mpegTsStreamErrorMessage(type: unknown, detail: unknown, extra: unknown): string {
  const http = mpegTsErrorHttpInfo(extra);
  const s = http.status;
  const d = String(detail ?? "");
  const t = String(type ?? "");

  if (mpegTsIsHttpStatusCodeError(detail)) {
    if (s === 502 || http.msg?.toLowerCase().includes("bad gateway")) {
      return (
        "HTTP 502 Bad Gateway: the stream endpoint returned an error instead of MPEG-TS data. " +
        "That usually means a temporary outage, an overloaded provider, a bad/expired session URL, or this app’s stream proxy could not reach the upstream—not a browser CORS problem. " +
        "Wait and try again, pick another backup link from your playlist, or use an HLS (.m3u8) channel if your provider offers one."
      );
    }
    if (s === 503 || s === 504) {
      return `HTTP ${s}: the stream host is temporarily unavailable or slow. Try again shortly, or use an HLS (.m3u8) feed if available.`;
    }
    if (s === 403) {
      return "HTTP 403: the server denied this stream (expired token, geo block, or required headers). Refresh your playlist from your provider.";
    }
    if (s === 404) {
      return "HTTP 404: stream not found—this URL may have moved or been removed.";
    }
    if (typeof s === "number" && s >= 500) {
      return `HTTP ${s}: upstream server error while loading the stream. Try again later or another channel.`;
    }
    if (typeof s === "number" && s >= 400) {
      return `HTTP ${s}: stream request rejected${http.msg ? ` — ${http.msg}` : ""}.`;
    }
  }

  const extraStr =
    extra != null && typeof extra === "object"
      ? JSON.stringify(extra).slice(0, 200)
      : extra != null
        ? String(extra).slice(0, 200)
        : "";

  return (
    `Stream error (${t}${d ? `: ${d}` : ""}${extraStr ? ` · ${extraStr}` : ""}). ` +
    "HTTP failures loading media are usually provider, URL, or proxy issues—not browser CORS. An HLS (.m3u8) URL often works better than raw TS in the browser."
  );
}

function getHlsLevelKbps(hls: Hls | null): number | null {
  if (!hls) return null;
  const x = hls as unknown as { levels?: { bitrate?: number }[]; currentLevel?: number };
  const idx = x.currentLevel;
  if (typeof idx !== "number" || idx < 0 || !x.levels?.[idx]) return null;
  const br = x.levels[idx]?.bitrate;
  return typeof br === "number" && br > 0 ? br / 1000 : null;
}

/** Clock for library seek row (supports long audiobooks). */
function formatPlaybackClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Fixed-width scale under the seek bar: always H:MM:SS (e.g. 0:03:45). */
function formatPlaybackClockHMS(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Shown next to the channel name so you can see how the stream is being decoded. */
export type PlaybackModeLabel =
  | "HLS · hls.js"
  | "HLS · hls.js · split proxy"
  | "HLS · native"
  | "HLS · blocked"
  | "MPEG-TS · mpegts.js"
  | "MPEG-TS · blocked"
  | "Native · direct"
  | "Native · record tap"
  | "Radio · native"
  | "Radio · record tap"
  | "Library · native"
  | "Local video · native"
  | "Local video · preparing MKV…"
  | "Local video · MP4 (cache)"
  | "Local video · MP4 (remux)"
  | "Local video · MP4 (transcoded)"
  | "URL · blocked";

export function VideoPlayer({
  channel,
  volume = 1,
  onVolumeChange,
  paneLabel,
  recordable = true,
  streamProxyOrigin,
  splitIsolateNetwork = false,
  playbackPane,
  onLocalLibraryAudioEnded,
}: VideoPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  /** Latest `channel` from props — stream effect cleanup compares against this for library restarts. */
  const latestChannelRef = useRef<Channel | null>(null);
  latestChannelRef.current = channel;
  const onLocalLibraryAudioEndedRef = useRef(onLocalLibraryAudioEnded);
  onLocalLibraryAudioEndedRef.current = onLocalLibraryAudioEnded;
  const playbackPaneRef = useRef(playbackPane);
  playbackPaneRef.current = playbackPane;
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const externalUrlRef = useRef<string | null>(null);
  const recordIdRef = useRef<string | null>(null);
  /** Same bytes as disk recording; only set in desktop after REC (single upstream). */
  const [recordTapPlayUrl, setRecordTapPlayUrl] = useState<string | null>(null);
  const prevStreamUrlForResetRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordErr, setRecordErr] = useState<string | null>(null);
  const [recordSavedPath, setRecordSavedPath] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackModeLabel | null>(null);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string>("off");
  const [ccEnabled, setCcEnabled] = useState(true);
  const subFileRef = useRef<HTMLInputElement>(null);
  const [bufferLine, setBufferLine] = useState("—");
  const [underLogoFailed, setUnderLogoFailed] = useState(false);
  /** Radio has no native `<video controls>`; keep UI in sync for the overlay play/pause button. */
  const [radioPlaying, setRadioPlaying] = useState(false);
  /** When Web Audio EQ is active, `<video>` stays at `volume === 1` and level comes from EQ (radio or local library). */
  const [radioEqWebAudioActive, setRadioEqWebAudioActive] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytErr, setYtErr] = useState<string | null>(null);

  type Mp3LyricsState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; data: LocalMp3LyricsResult };
  const [mp3Lyrics, setMp3Lyrics] = useState<Mp3LyricsState>({ kind: "idle" });
  const [mp3LyricsHidden, setMp3LyricsHidden] = useState(false);
  const [mp3LyricsRefresh, setMp3LyricsRefresh] = useState(0);
  /** Artist / title / album from file tags (shown above lyrics). */
  const [lyricsTrackMeta, setLyricsTrackMeta] = useState<TrackFileMetadata | null>(null);
  /** LLM “what this song is about” — separate from lyrics fetch so duration updates do not abort it. */
  const [songMeaningLoading, setSongMeaningLoading] = useState(false);
  const songMeaningSectionRef = useRef<HTMLElement | null>(null);
  const mp3LyricsPanelRef = useRef<HTMLDivElement | null>(null);
  const playerRootRef = useRef<HTMLDivElement | null>(null);
  /** Expanded lyrics fill this player column only (split view: Player L / R), not the whole monitor. */
  const [lyricsSpatialBox, setLyricsSpatialBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const lyricsSpatialFullscreen = lyricsSpatialBox !== null;
  /** Next lyrics fetch should ignore IndexedDB cache (Refresh lyrics). */
  const skipLyricsCacheOnceRef = useRef(false);
  const lyricsTranslateAbortRef = useRef<AbortController | null>(null);
  const [lyricsOverridePairs, setLyricsOverridePairs] = useState<LyricLinePair[] | null>(null);
  const [lyricsTranslateTarget, setLyricsTranslateTarget] = useState<string | null>(null);
  const [lyricsTranslateBusy, setLyricsTranslateBusy] = useState(false);
  const [lyricsTranslateErr, setLyricsTranslateErr] = useState<string | null>(null);
  const [lyricsTranslateHint, setLyricsTranslateHint] = useState<string | null>(null);
  /** `<audio|video>.duration` when playing a local MP3 — improves LRCLIB `/api/get` matches. */
  const [libAudioDurationSec, setLibAudioDurationSec] = useState<number | null>(null);
  /** Local library playback position for the chrome seek bar (lyrics overlay hides native controls). */
  const [libSeekUiSec, setLibSeekUiSec] = useState(0);
  /** Local library `<video>` paused — drives chrome transport when lyrics cover native controls. */
  const [libTransportPaused, setLibTransportPaused] = useState(true);
  /** Playback speed for local library audio (audiobooks / music). */
  const [libPlaybackRate, setLibPlaybackRate] = useState(1);
  const volumePopoverRef = useRef<HTMLDivElement>(null);
  const [volumePopoverOpen, setVolumePopoverOpen] = useState(false);
  /** Bump to re-run the stream bind effect for the same radio channel (reconnect). */
  const [radioStreamReloadTick, setRadioStreamReloadTick] = useState(0);
  const [playerChromeNotice, setPlayerChromeNotice] = useState<string | null>(null);

  const hasDesktopRecordApi =
    typeof window !== "undefined" &&
    !!window.iptv?.pickRecordDir &&
    !!window.iptv?.startStreamRecord &&
    !!window.iptv?.stopStreamRecord;

  const streamOkForRecord =
    !!channel?.url?.trim() && canRecordRawHttpStream(channel.url, channel.id);
  const isRadioChannel = !!channel?.id && isRadioStationChannelId(channel.id);
  const isLibraryChannel =
    !!channel?.libraryTrackId?.trim() &&
    !!channel.url?.trim() &&
    channel.url.trim().toLowerCase().startsWith("blob:");
  const isLocalVideoChannel =
    !!channel?.localVideoFile &&
    !!channel.url?.trim() &&
    (/^file:/i.test(channel.url.trim()) || /^blob:/i.test(channel.url.trim()));

  const lyricsDurationKey =
    libAudioDurationSec != null && Number.isFinite(libAudioDurationSec) && libAudioDurationSec > 2
      ? Math.round(libAudioDurationSec)
      : null;

  useLayoutEffect(() => {
    if (!lyricsSpatialBox) return;
    const root = playerRootRef.current;
    if (!root) return;
    const apply = () => {
      const r = root.getBoundingClientRect();
      setLyricsSpatialBox((b) => {
        if (!b) return null;
        if (b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height) return b;
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(root);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [lyricsSpatialFullscreen]);

  useEffect(() => {
    if (!lyricsSpatialFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLyricsSpatialBox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lyricsSpatialFullscreen]);

  const toggleLyricsFullscreen = useCallback(() => {
    const root = playerRootRef.current;
    if (!root) return;
    setLyricsSpatialBox((prev) => {
      if (prev) return null;
      const r = root.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    });
  }, []);

  const hideLyricsPanel = useCallback(() => {
    setLyricsSpatialBox(null);
    setMp3LyricsHidden(true);
  }, []);

  useEffect(() => {
    setUnderLogoFailed(false);
  }, [channel?.id, channel?.logo]);

  const mediaEqEnabled = isRadioChannel || isLibraryChannel;

  useEffect(() => {
    if (!mediaEqEnabled) setRadioEqWebAudioActive(false);
  }, [mediaEqEnabled]);

  useEffect(() => {
    setYtErr(null);
    setYtBusy(false);
    setMp3Lyrics({ kind: "idle" });
    setMp3LyricsHidden(false);
    lyricsTranslateAbortRef.current?.abort();
    lyricsTranslateAbortRef.current = null;
    setLyricsOverridePairs(null);
    setLyricsTranslateTarget(null);
    setLyricsTranslateBusy(false);
    setLyricsTranslateErr(null);
    setLyricsTranslateHint(null);
    setLibAudioDurationSec(null);
    setLibSeekUiSec(0);
    setLibTransportPaused(true);
    setLibPlaybackRate(1);
    setVolumePopoverOpen(false);
    setLyricsSpatialBox(null);
  }, [channel?.id]);

  useEffect(() => {
    if (!channel || !isLibraryChannel) {
      setLibAudioDurationSec(null);
      return;
    }
    let cancelled = false;
    const readDur = () => {
      if (cancelled) return;
      const el = mediaRef.current;
      const d = el?.duration;
      if (typeof d === "number" && Number.isFinite(d) && d > 1.5) {
        setLibAudioDurationSec(d);
      }
    };
    const delays = [0, 100, 350, 800, 1600];
    const timers = delays.map((ms) => window.setTimeout(readDur, ms));
    const el = mediaRef.current;
    if (el) {
      const onMeta = () => readDur();
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("durationchange", onMeta);
      el.addEventListener("canplay", onMeta);
      return () => {
        cancelled = true;
        for (const t of timers) clearTimeout(t);
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("durationchange", onMeta);
        el.removeEventListener("canplay", onMeta);
      };
    }
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [channel?.id, channel?.libraryTrackId, channel?.url]);

  /** Keep library seek bar in sync (full-screen lyrics overlay hides native `<video>` timeline). */
  useEffect(() => {
    if (!isLibraryChannel) {
      setLibSeekUiSec(0);
      setLibTransportPaused(true);
      return;
    }
    const el = mediaRef.current;
    if (!el) return;
    const sync = () => {
      const t = el.currentTime;
      if (Number.isFinite(t) && t >= 0) setLibSeekUiSec(t);
      setLibTransportPaused(el.paused);
    };
    sync();
    el.addEventListener("timeupdate", sync);
    el.addEventListener("seeked", sync);
    el.addEventListener("loadedmetadata", sync);
    el.addEventListener("playing", sync);
    el.addEventListener("play", sync);
    el.addEventListener("pause", sync);
    el.addEventListener("ended", sync);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("seeked", sync);
      el.removeEventListener("loadedmetadata", sync);
      el.removeEventListener("playing", sync);
      el.removeEventListener("play", sync);
      el.removeEventListener("pause", sync);
      el.removeEventListener("ended", sync);
    };
  }, [isLibraryChannel, channel?.id, channel?.url]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !isLibraryChannel) return;
    const r = Number(libPlaybackRate);
    if (Number.isFinite(r) && r >= 0.5 && r <= 3) {
      el.playbackRate = r;
    }
  }, [isLibraryChannel, libPlaybackRate, channel?.id]);

  useEffect(() => {
    if (!volumePopoverOpen) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      const host = volumePopoverRef.current;
      const t = ev.target;
      if (!(t instanceof Node)) return;
      if (host && !host.contains(t)) setVolumePopoverOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setVolumePopoverOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [volumePopoverOpen]);

  useEffect(() => {
    if (!isRadioChannel) {
      setRadioPlaying(false);
      return;
    }
    const el = mediaRef.current;
    if (!el) return;
    const sync = () => setRadioPlaying(!el.paused);
    sync();
    el.addEventListener("play", sync);
    el.addEventListener("playing", sync);
    el.addEventListener("pause", sync);
    el.addEventListener("ended", sync);
    return () => {
      el.removeEventListener("play", sync);
      el.removeEventListener("playing", sync);
      el.removeEventListener("pause", sync);
      el.removeEventListener("ended", sync);
    };
  }, [isRadioChannel, channel?.id]);

  useEffect(() => {
    const ch = channel;
    if (!ch || !isLikelyLocalMp3Channel(ch)) {
      setLyricsTrackMeta(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const meta = await resolveTrackMetadataFromLibrary(ch.name, ch.libraryTrackId);
      if (!cancelled) setLyricsTrackMeta(meta);
    })();
    return () => {
      cancelled = true;
    };
  }, [channel?.id, channel?.name, channel?.libraryTrackId]);

  useEffect(() => {
    const ch = channel;
    if (!ch || !isLikelyLocalMp3Channel(ch)) {
      setMp3Lyrics({ kind: "idle" });
      return;
    }
    const ac = new AbortController();
    const run = async () => {
      const tid = ch.libraryTrackId?.trim();
      const skipCache = skipLyricsCacheOnceRef.current;
      skipLyricsCacheOnceRef.current = false;

      if (tid && !skipCache && typeof indexedDB !== "undefined") {
        try {
          const cached = await getLibraryLyricsCache(tid);
          if (cached?.pairs?.length && !ac.signal.aborted) {
            setMp3Lyrics({ kind: "ready", data: mapCachedLibraryLyricsToResult(cached) });
            return;
          }
        } catch {
          /* ignore */
        }
      }

      setMp3Lyrics({ kind: "loading" });
      const el = mediaRef.current;
      const inline = el?.duration;
      const inlineOk = typeof inline === "number" && Number.isFinite(inline) && inline > 2 ? inline : null;
      const durationSec =
        lyricsDurationKey != null && lyricsDurationKey > 2 ? lyricsDurationKey : inlineOk;
      try {
        const data = await fetchBilingualLyricsForLocalMp3(ch.name, durationSec, ac.signal, {
          libraryTrackId: ch.libraryTrackId?.trim(),
        });
        if (!ac.signal.aborted) setMp3Lyrics({ kind: "ready", data });
      } catch (e) {
        if (ac.signal.aborted) return;
        setMp3Lyrics({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    };
    void run();
    return () => ac.abort();
  }, [
    channel?.id,
    channel?.name,
    channel?.url,
    channel?.libraryTrackId,
    channel?.libraryContentType,
    mp3LyricsRefresh,
    lyricsDurationKey,
  ]);

  const readyLyrics = mp3Lyrics.kind === "ready" ? mp3Lyrics.data : null;
  const readyLyricsMeaning = readyLyrics?.songMeaning?.trim() ?? "";
  const readyLyricsMeaningError = readyLyrics?.songMeaningError?.trim() ?? "";

  const lyricsDisplayPairs = useMemo(() => {
    if (mp3Lyrics.kind !== "ready") return [];
    return lyricsOverridePairs ?? mp3Lyrics.data.pairs;
  }, [mp3Lyrics, lyricsOverridePairs]);

  const lyricsTranslateLangLabel = lyricsTranslateTarget
    ? labelForLyricsTargetCode(lyricsTranslateTarget)
    : null;

  const lyricsDisplayMeta = useMemo(() => {
    const fromResult =
      mp3Lyrics.kind === "ready"
        ? {
            artist: mp3Lyrics.data.metaArtist?.trim() ?? "",
            title: mp3Lyrics.data.metaTitle?.trim() ?? "",
          }
        : { artist: "", title: "" };
    const artist =
      fromResult.artist ||
      lyricsTrackMeta?.artist.trim() ||
      "";
    const title =
      fromResult.title ||
      lyricsTrackMeta?.title.trim() ||
      "";
    const album = lyricsTrackMeta?.album.trim() || "";
    if (!artist && !title) return null;
    return {
      artist,
      title,
      album,
      fromTags: lyricsTrackMeta?.source === "tags",
    };
  }, [mp3Lyrics, lyricsTrackMeta]);

  /** Short label for the lyrics panel header (avoid LRCLIB / translation / “restored from cache” debug strings). */
  const lyricsPanelTitle = useMemo(() => {
    if (mp3Lyrics.kind === "loading") return "Fetching lyrics…";
    if (mp3Lyrics.kind === "error") return "Could not load lyrics";
    if (mp3Lyrics.kind === "ready") {
      const d = lyricsDisplayMeta;
      if (d?.artist && d?.title) return `${d.artist} — ${d.title}`;
      if (d?.title) return d.title;
      if (d?.artist) return d.artist;
      const n = channel?.name?.trim();
      if (n) return n;
      return "Lyrics";
    }
    return "Lyrics";
  }, [mp3Lyrics.kind, lyricsDisplayMeta, channel?.name]);

  /** Time labels under the library seek bar (start → end). */
  const librarySeekScaleTicks = useMemo(() => {
    const d = libAudioDurationSec;
    if (d == null || !(d > 1.5)) return null;
    return [0, 0.25, 0.5, 0.75, 1].map((f) => f * d);
  }, [libAudioDurationSec]);

  useEffect(() => {
    lyricsTranslateAbortRef.current?.abort();
    lyricsTranslateAbortRef.current = null;
    setLyricsOverridePairs(null);
    setLyricsTranslateTarget(null);
    setLyricsTranslateErr(null);
    setLyricsTranslateHint(null);
  }, [channel?.id, mp3LyricsRefresh]);

  const onLyricsTranslateLanguage = useCallback(
    async (targetCode: string) => {
      if (mp3Lyrics.kind !== "ready" || !mp3Lyrics.data.pairs.length) return;
      lyricsTranslateAbortRef.current?.abort();
      const ac = new AbortController();
      lyricsTranslateAbortRef.current = ac;
      setLyricsTranslateBusy(true);
      setLyricsTranslateErr(null);
      setLyricsTranslateHint(null);
      const origLines = mp3Lyrics.data.pairs.map((p) => p.orig);
      try {
        const fetchJson = createLyricsJsonFetcher();
        const tr = await translateLineBatchesToLanguage(
          origLines,
          targetCode,
          mp3Lyrics.data.detectedFranc3,
          fetchJson,
          ac.signal
        );
        if (ac.signal.aborted) return;
        const pairs: LyricLinePair[] = origLines.map((orig, i) => ({
          orig,
          en: tr.lines[i] ?? orig,
        }));
        setLyricsOverridePairs(pairs);
        setLyricsTranslateTarget(targetCode);
        const langLabel = labelForLyricsTargetCode(targetCode);
        setLyricsTranslateHint(
          tr.providerHint ? `Translated to ${langLabel} · ${tr.providerHint}` : `Translated to ${langLabel}`
        );
      } catch (e) {
        if (ac.signal.aborted) return;
        setLyricsTranslateErr(e instanceof Error ? e.message : String(e));
        setLyricsOverridePairs(null);
        setLyricsTranslateTarget(null);
      } finally {
        if (!ac.signal.aborted) setLyricsTranslateBusy(false);
      }
    },
    [mp3Lyrics]
  );

  useEffect(() => {
    const ch = channel;
    if (!ch || !isLikelyLocalMp3Channel(ch) || mp3Lyrics.kind !== "ready") {
      setSongMeaningLoading(false);
      return;
    }
    const data = mp3Lyrics.data;
    if (!data.pairs.length) {
      setSongMeaningLoading(false);
      return;
    }
    if (readyLyricsMeaning || readyLyricsMeaningError) {
      setSongMeaningLoading(false);
      return;
    }
    const tid = ch.libraryTrackId?.trim();
    if (!tid) {
      setSongMeaningLoading(false);
      return;
    }

    const ac = new AbortController();
    setSongMeaningLoading(true);
    void (async () => {
      try {
        const enriched = await enrichLocalMp3LyricsWithSongMeaning(data, ch.name, tid, ac.signal);
        if (!ac.signal.aborted) {
          setMp3Lyrics({ kind: "ready", data: enriched });
          if (enriched.songMeaning) {
            requestAnimationFrame(() => {
              songMeaningSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            });
          }
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setMp3Lyrics({
          kind: "ready",
          data: { ...data, songMeaningError: msg || "Could not load song meaning." },
        });
      } finally {
        if (!ac.signal.aborted) setSongMeaningLoading(false);
      }
    })();

    return () => {
      ac.abort();
      setSongMeaningLoading(false);
    };
  }, [
    channel?.id,
    channel?.name,
    channel?.libraryTrackId,
    mp3Lyrics.kind,
    mp3LyricsRefresh,
    readyLyricsMeaning,
    readyLyricsMeaningError,
    readyLyrics?.pairs.length,
  ]);

  const canStartRecording = recordable && streamOkForRecord && hasDesktopRecordApi;
  /** Hide REC and related chrome for local library audio (blob playback). */
  const showRecordChrome = recordable && !isLibraryChannel;

  const recordButtonTitle = !recordable
    ? ""
    : !hasDesktopRecordApi
      ? "Record live stream to a folder you choose — install the RJ IPTV and Online Radio Player Windows desktop app."
      : !streamOkForRecord
        ? isLikelyHls(channel?.url ?? "")
          ? "HLS (.m3u8) cannot be saved as one continuous raw file. Use a direct stream URL if the station offers one."
          : isRadioChannel
            ? "This station URL cannot be recorded from the app (needs http(s), not HLS)."
            : "This URL is not a continuous MPEG-TS stream (or http audio). Use a TS-style IPTV URL or a direct radio stream."
        : isRadioChannel
          ? "Save the live audio stream to disk (same bytes as playback via one upstream on desktop)."
          : "Save the live transport stream to a .mpeg file. On desktop, one upstream feeds both playback and disk so recording does not halve your bandwidth.";

  useEffect(() => {
    return () => {
      const id = recordIdRef.current;
      if (id && window.iptv?.stopStreamRecord) {
        void window.iptv.stopStreamRecord(id);
      }
      recordIdRef.current = null;
      setRecording(false);
      setRecordTapPlayUrl(null);
      setRecordSavedPath(null);
    };
  }, [channel?.url]);

  useEffect(() => {
    if (!channel?.url?.trim()) {
      setBufferLine("—");
      return;
    }
    const last = { ahead: 0, ts: performance.now() };
    const tick = () => {
      const v = mediaRef.current;
      if (!v) return;
      const ahead = getBufferedAheadSec(v);
      const now = performance.now();
      const dt = (now - last.ts) / 1000;
      const fillSs = dt >= 0.35 ? (ahead - last.ahead) / dt : 0;
      last.ahead = ahead;
      last.ts = now;
      const levelKbps = getHlsLevelKbps(hlsRef.current);
      setBufferLine(formatBufferStatsLine({ aheadSec: ahead, fillSs, levelKbps }));
    };
    tick();
    const id = window.setInterval(tick, 450);
    return () => clearInterval(id);
  }, [channel?.url]);

  const refreshTextTracks = useCallback(() => {
    const video = mediaRef.current;
    if (!video) return;
    const list = video.textTracks;
    const opts: TrackOption[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.kind !== "subtitles" && t.kind !== "captions") continue;
      const label = t.label || t.language || `Track ${i + 1}`;
      opts.push({ id: `native-${i}`, label, index: i });
    }
    setTrackOptions(opts);
  }, []);

  useEffect(() => {
    const video = mediaRef.current;
    if (!video) return;

    const urlKey = channel?.url?.trim() ?? null;
    if (prevStreamUrlForResetRef.current !== urlKey) {
      prevStreamUrlForResetRef.current = urlKey;
      setRecording(false);
      setRecordErr(null);
      setRecordSavedPath(null);
    }

    hlsRef.current?.destroy();
    hlsRef.current = null;
    mpegtsRef.current?.destroy();
    mpegtsRef.current = null;
    if (externalUrlRef.current) {
      URL.revokeObjectURL(externalUrlRef.current);
      externalUrlRef.current = null;
    }
    video.removeAttribute("src");
    video.querySelectorAll("source[data-iptv-library]").forEach((node) => node.remove());
    video.querySelectorAll("track[data-iptv-external]").forEach((node) => node.remove());
    video.load();

    setError(null);
    setPlaybackMode(null);
    setTrackOptions([]);
    setSelectedTrack("off");

    if (!channel?.url) return;

    const url = channel.url.trim();
    if (!url) {
      setError("Empty stream URL.");
      return;
    }

    const el = video;

    let skipDefaultFinish = false;
    const isMatroskaFileUrl = (u: string) => {
      try {
        if (!/^file:/i.test(u)) return false;
        const pth = decodeURIComponent(new URL(u).pathname).replace(/\\/g, "/").toLowerCase();
        return pth.endsWith(".mkv") || pth.endsWith(".mka");
      } catch {
        return false;
      }
    };

    const onTracks = () => refreshTextTracks();

    const proxyBase = streamProxyOrigin?.trim() || undefined;

    let effectLive = true;
    let mpegtsTransientRetries = 0;
    let mpegtsRetryTimer: number | null = null;

    const bindMpegTsPlayer = (streamUrl: string, tapPlayUrl: string | null): boolean => {
      if (!mpegts.isSupported()) return false;
      try {
        mpegtsRef.current?.destroy();
        mpegtsRef.current = null;
        const tap = tapPlayUrl?.trim() ?? "";
        const playUrl = tap ? tap : proxiedStreamUrl(streamUrl, proxyBase);
        const mpegExtras =
          playUrl === streamUrl ? mpegtsIptvConfig(streamUrl) : { reuseRedirectedURL: true };
        const stashInitialSize = tap
          ? Math.floor(2.75 * 1024 * 1024)
          : splitIsolateNetwork
            ? 512 * 1024
            : 1024 * 1024;
        const player = mpegts.createPlayer(
        {
          type: "mse",
          isLive: true,
          url: playUrl,
          cors: true,
        },
        {
          enableWorker: true,
          /* Stash buffers network jitter; false caused frequent rebuffer on IPTV. */
          enableStashBuffer: true,
          stashInitialSize,
          /* Latency chasing adjusts playback often and can feel like a stall every few seconds. */
          liveBufferLatencyChasing: false,
          liveSync: false,
          lazyLoad: false,
          ...mpegExtras,
        }
      );
      mpegtsRef.current = player;
      player.attachMediaElement(el);
      player.on(mpegts.Events.MEDIA_INFO, () => {
        mpegtsTransientRetries = 0;
        onTracks();
      });
      player.on(mpegts.Events.ERROR, (...args: unknown[]) => {
        const [type, detail, extra] = args;
        const http = mpegTsErrorHttpInfo(extra);
        const transientHttp =
          mpegTsIsHttpStatusCodeError(detail) &&
          (http.status === 502 || http.status === 503 || http.status === 504);

        if (transientHttp && mpegtsTransientRetries < 3 && effectLive) {
          mpegtsTransientRetries++;
          setError(null);
          try {
            player.pause();
          } catch {
            /* noop */
          }
          mpegtsRef.current?.destroy();
          mpegtsRef.current = null;
          if (mpegtsRetryTimer != null) {
            clearTimeout(mpegtsRetryTimer);
            mpegtsRetryTimer = null;
          }
          const delay = 900 + mpegtsTransientRetries * 600;
          mpegtsRetryTimer = window.setTimeout(() => {
            mpegtsRetryTimer = null;
            if (!effectLive) return;
            if (bindMpegTsPlayer(streamUrl, tapPlayUrl)) {
              void el.play().catch(() => {});
            }
          }, delay);
          return;
        }

        setError(mpegTsStreamErrorMessage(type, detail, extra));
      });
      player.load();
      return true;
      } catch {
        mpegtsRef.current = null;
        return false;
      }
    };

    let nativeErrCleanup: (() => void) | null = null;

    if (channel.libraryTrackId?.trim() && url.toLowerCase().startsWith("blob:")) {
      const trackId = channel.libraryTrackId.trim();
      let lastThrottleMs = 0;
      const persistPosition = () => {
        const t = el.currentTime;
        if (!Number.isFinite(t) || t < 0.5) return;
        const dur = el.duration;
        if (Number.isFinite(dur) && dur > 0 && t >= dur - 1) {
          clearAudioResume(trackId);
          return;
        }
        saveAudioResumeSeconds(trackId, t);
      };
      let resumeApplied = false;
      const applyResume = () => {
        if (resumeApplied) return;
        const dur = el.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const saved = loadAudioResumeSeconds(trackId);
        if (saved == null || saved < 1) {
          resumeApplied = true;
          return;
        }
        if (saved >= dur - 2) {
          clearAudioResume(trackId);
          resumeApplied = true;
          return;
        }
        el.currentTime = saved;
        resumeApplied = true;
      };
      const onTimeUpdate = () => {
        const now = performance.now();
        if (now - lastThrottleMs < 3500) return;
        lastThrottleMs = now;
        persistPosition();
      };
      const onPause = () => persistPosition();
      const onEnded = () => {
        const dur = el.duration;
        if (Number.isFinite(dur) && dur > 0) clearAudioResume(trackId);
        const fn = onLocalLibraryAudioEndedRef.current;
        const pane = playbackPaneRef.current;
        if (typeof fn === "function" && (pane === "L" || pane === "R")) {
          fn({ pane, channelId: channel.id });
        }
      };
      const onPageHide = () => persistPosition();

      let libReadyDone = false;
      function onLibReady() {
        if (libReadyDone || el.error) return;
        const dur = el.duration;
        const hasPositiveDuration = Number.isFinite(dur) && dur > 0;
        /* Some files report NaN/0 duration at HAVE_METADATA; wait until we can decode current data. */
        if (!hasPositiveDuration && el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        libReadyDone = true;
        el.removeEventListener("loadedmetadata", onLibReady);
        el.removeEventListener("loadeddata", onLibReady);
        el.removeEventListener("canplay", onLibReady);
        el.removeEventListener("error", onLibError);
        applyResume();
        onTracks();
      }
      function onLibError() {
        el.removeEventListener("loadedmetadata", onLibReady);
        el.removeEventListener("loadeddata", onLibReady);
        el.removeEventListener("canplay", onLibReady);
        setPlaybackMode(null);
        const er = el.error;
        const code = er?.code;
        const hint =
          code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? " — Chromium could not decode this blob (wrong or missing MIME)."
            : code != null
              ? ` (media error ${code})`
              : "";
        setError(
          `Could not play this file${hint}${er?.message ? `: ${er.message}` : ""}`.trim()
        );
      }

      el.removeAttribute("src");
      el.querySelectorAll("source[data-iptv-library]").forEach((node) => node.remove());
      el.src = url;

      el.addEventListener("error", onLibError, { once: true });
      el.addEventListener("loadedmetadata", onLibReady);
      el.addEventListener("loadeddata", onLibReady);
      el.addEventListener("canplay", onLibReady);
      el.addEventListener("timeupdate", onTimeUpdate);
      el.addEventListener("pause", onPause);
      el.addEventListener("ended", onEnded);
      window.addEventListener("pagehide", onPageHide);

      nativeErrCleanup = () => {
        const latest = latestChannelRef.current;
        const sameLibraryReload =
          latest?.libraryTrackId?.trim() === trackId && (latest.url?.trim() ?? "") === url;
        const restartingFromStart =
          typeof latest?.libraryRestartNonce === "number" &&
          latest.libraryRestartNonce !== channel.libraryRestartNonce;
        if (!(sameLibraryReload && restartingFromStart)) {
          persistPosition();
        }
        el.removeEventListener("error", onLibError);
        el.removeEventListener("loadedmetadata", onLibReady);
        el.removeEventListener("loadeddata", onLibReady);
        el.removeEventListener("canplay", onLibReady);
        el.removeEventListener("timeupdate", onTimeUpdate);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("ended", onEnded);
        window.removeEventListener("pagehide", onPageHide);
        el.removeAttribute("src");
        el.querySelectorAll("source[data-iptv-library]").forEach((node) => node.remove());
      };

      setPlaybackMode("Library · native");
      el.load();
    } else if (channel.localVideoFile && (/^file:/i.test(url) || /^blob:/i.test(url))) {
      const origLower = (channel.localOriginalFileName ?? "").trim().toLowerCase();
      const blobMkvBlocked =
        /^blob:/i.test(url) &&
        typeof window !== "undefined" &&
        typeof window.iptv?.prepareMkvPlayback === "function" &&
        (origLower.endsWith(".mkv") || origLower.endsWith(".mka"));

      if (blobMkvBlocked) {
        skipDefaultFinish = true;
        setPlaybackMode(null);
        setError(
          "MKV cannot play from the browser file picker in the desktop app. Use “+ Add local video” so FFmpeg can read the file from disk."
        );
      } else {
      const resumeId = channel.id.trim();
      let lastThrottleMs = 0;
      const persistPosition = () => {
        const t = el.currentTime;
        if (!Number.isFinite(t) || t < 0.5) return;
        const dur = el.duration;
        if (Number.isFinite(dur) && dur > 0 && t >= dur - 1) {
          clearVideoResume(resumeId);
          return;
        }
        saveVideoResumeSeconds(resumeId, t);
      };
      let resumeApplied = false;
      const applyResume = () => {
        if (resumeApplied) return;
        const dur = el.duration;
        if (!Number.isFinite(dur) || dur <= 0) return;
        const saved = loadVideoResumeSeconds(resumeId);
        if (saved == null || saved < 1) {
          resumeApplied = true;
          return;
        }
        if (saved >= dur - 2) {
          clearVideoResume(resumeId);
          resumeApplied = true;
          return;
        }
        el.currentTime = saved;
        resumeApplied = true;
      };
      const onTimeUpdate = () => {
        const now = performance.now();
        if (now - lastThrottleMs < 3500) return;
        lastThrottleMs = now;
        persistPosition();
      };
      const onPause = () => persistPosition();
      const onEnded = () => {
        const dur = el.duration;
        if (Number.isFinite(dur) && dur > 0) clearVideoResume(resumeId);
      };
      const onPageHide = () => persistPosition();

      let localVidReadyDone = false;
      function onLocalVideoReady() {
        if (localVidReadyDone || el.error) return;
        const dur = el.duration;
        const hasPositiveDuration = Number.isFinite(dur) && dur > 0;
        if (!hasPositiveDuration && el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        localVidReadyDone = true;
        el.removeEventListener("loadedmetadata", onLocalVideoReady);
        el.removeEventListener("loadeddata", onLocalVideoReady);
        el.removeEventListener("canplay", onLocalVideoReady);
        el.removeEventListener("error", onLocalVideoError);
        applyResume();
        onTracks();
      }
      function onLocalVideoError() {
        el.removeEventListener("loadedmetadata", onLocalVideoReady);
        el.removeEventListener("loadeddata", onLocalVideoReady);
        el.removeEventListener("canplay", onLocalVideoReady);
        setPlaybackMode(null);
        setError(
          "Could not play this local file. If it is MKV, try the Windows desktop app (uses FFmpeg). Otherwise try H.264/AAC in MP4, or pick the file again."
        );
      }

      const bindLocalVideoSource = (playUrl: string, mimeForSource?: string | null) => {
        localVidReadyDone = false;
        el.removeEventListener("error", onLocalVideoError);
        el.removeEventListener("loadedmetadata", onLocalVideoReady);
        el.removeEventListener("loadeddata", onLocalVideoReady);
        el.removeEventListener("canplay", onLocalVideoReady);

        el.addEventListener("error", onLocalVideoError, { once: true });
        el.addEventListener("loadedmetadata", onLocalVideoReady);
        el.addEventListener("loadeddata", onLocalVideoReady);
        el.addEventListener("canplay", onLocalVideoReady);
        el.addEventListener("timeupdate", onTimeUpdate);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        window.addEventListener("pagehide", onPageHide);

        nativeErrCleanup = () => {
          persistPosition();
          el.removeEventListener("error", onLocalVideoError);
          el.removeEventListener("loadedmetadata", onLocalVideoReady);
          el.removeEventListener("loadeddata", onLocalVideoReady);
          el.removeEventListener("canplay", onLocalVideoReady);
          el.removeEventListener("timeupdate", onTimeUpdate);
          el.removeEventListener("pause", onPause);
          el.removeEventListener("ended", onEnded);
          window.removeEventListener("pagehide", onPageHide);
          el.removeAttribute("src");
          el.querySelectorAll("source[data-iptv-local-video]").forEach((node) => node.remove());
        };

        el.removeAttribute("src");
        el.querySelectorAll("source[data-iptv-local-video]").forEach((node) => node.remove());
        const srcEl = document.createElement("source");
        srcEl.setAttribute("data-iptv-local-video", "1");
        srcEl.src = playUrl;
        const typeHint =
          (mimeForSource && mimeForSource.trim()) ||
          (channel.libraryContentType && channel.libraryContentType.trim()) ||
          mimeHintForLocalVideoUrl(playUrl);
        if (typeHint) srcEl.type = typeHint;
        el.appendChild(srcEl);
        el.load();
      };

      const canPrepareMkv =
        isMatroskaFileUrl(url) && typeof window !== "undefined" && typeof window.iptv?.prepareMkvPlayback === "function";

      if (canPrepareMkv) {
        skipDefaultFinish = true;
        setPlaybackMode("Local video · preparing MKV…");
        const iptvMk = window.iptv!;
        void iptvMk
          .prepareMkvPlayback(url)
          .then((r) => {
            if (!effectLive) return;
            const playUrl = typeof r?.playUrl === "string" && r.playUrl.trim() ? r.playUrl.trim() : url;
            const mimeForSource =
              typeof r?.mimeType === "string" && r.mimeType.trim() ? r.mimeType.trim() : "video/mp4";
            bindLocalVideoSource(playUrl, mimeForSource);
            if (r?.fromCache) setPlaybackMode("Local video · MP4 (cache)");
            else if (r?.remuxed) setPlaybackMode("Local video · MP4 (remux)");
            else if (r?.usedTranscode) setPlaybackMode("Local video · MP4 (transcoded)");
            else setPlaybackMode("Local video · native");
            el.addEventListener("addtrack", onTracks as EventListener);
            void el.play().catch(() => {});
          })
          .catch((e) => {
            if (!effectLive) return;
            setPlaybackMode(null);
            setError(
              e instanceof Error
                ? e.message
                : "Could not prepare MKV for playback. Use the Windows desktop build with FFmpeg bundled."
            );
          });
      } else {
        bindLocalVideoSource(url, null);
        setPlaybackMode("Local video · native");
      }
      }
    } else if (isLikelyHls(url)) {
      if (Hls.isSupported()) {
        const splitHlsViaLocalProxy =
          !!splitIsolateNetwork &&
          shouldUseStreamProxy() &&
          typeof fetch !== "undefined" &&
          typeof Request !== "undefined";
        const hlsProxyBase =
          (proxyBase || (typeof window !== "undefined" ? window.location.origin : "")) || "";

        /** Split view: cap quality to each pane’s video box, trim back-buffer, and ease ABR so two decoders / networks contend less. */
        const sharedLive: Partial<ConstructorParameters<typeof Hls>[0]> = {
          lowLatencyMode: false,
          maxBufferHole: 0.5,
          liveSyncDurationCount: 4,
          liveMaxLatencyDurationCount: 14,
          ...(splitIsolateNetwork
            ? {
                capLevelToPlayerSize: true,
                backBufferLength: 45,
                maxBufferLength: 42,
                maxMaxBufferLength: 100,
                maxBufferSize: 42 * 1000 * 1000,
                maxStarvationDelay: 6,
                maxLoadingDelay: 8,
              }
            : {
                maxBufferLength: 55,
                maxMaxBufferLength: 150,
              }),
        };

        const hlsConfig: Partial<ConstructorParameters<typeof Hls>[0]> =
          splitHlsViaLocalProxy && hlsProxyBase
            ? {
                enableWebVTT: true,
                renderTextTracksNatively: true,
                ...sharedLive,
                loader: FetchLoader,
                fetchSetup: (context, initParams) => {
                  const raw = context.url;
                  const target = isAlreadyProxiedStreamUrl(raw)
                    ? raw
                    : proxiedStreamUrl(raw, hlsProxyBase);
                  return new Request(target, initParams ?? {});
                },
              }
            : {
                enableWebVTT: true,
                renderTextTracksNatively: true,
                ...sharedLive,
                xhrSetup: (xhr, requestUrl) => {
                  const ref = streamRefererForUrl(requestUrl);
                  if (ref) xhr.setRequestHeader("Referer", ref);
                },
              };

        const hls = new Hls(hlsConfig);
        hlsRef.current = hls;
        const manifestSrc =
          splitHlsViaLocalProxy && hlsProxyBase && !isAlreadyProxiedStreamUrl(url)
            ? proxiedStreamUrl(url, hlsProxyBase)
            : url;
        /** Count consecutive fatal network errors before any level loads (reset on LEVEL_LOADED / MANIFEST_PARSED). */
        let hlsNetworkFatalStreak = 0;
        /** 0 = none, 1 = recoverMediaError tried, 2 = swapAudioCodec + recover tried. */
        let hlsMediaRecoveryStep = 0;

        const resetHlsLiveErrorBudget = () => {
          hlsNetworkFatalStreak = 0;
          hlsMediaRecoveryStep = 0;
        };

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          resetHlsLiveErrorBudget();
          onTracks();
        });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, onTracks);
        hls.on(Hls.Events.LEVEL_LOADED, () => {
          hlsNetworkFatalStreak = 0;
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;

          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hlsNetworkFatalStreak++;
            try {
              hls.startLoad();
            } catch {
              /* noop */
            }
            if (hlsNetworkFatalStreak <= 4) {
              setError(null);
              return;
            }
            setError(
              "Network error: the stream stopped loading after several retries. Check your connection, provider status, or try again later."
            );
            return;
          }

          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (hlsMediaRecoveryStep === 0) {
              hlsMediaRecoveryStep = 1;
              setError(null);
              try {
                hls.recoverMediaError();
              } catch {
                setError("Playback error (decoder could not recover).");
              }
              return;
            }
            if (hlsMediaRecoveryStep === 1) {
              hlsMediaRecoveryStep = 2;
              setError(null);
              try {
                hls.swapAudioCodec();
                hls.recoverMediaError();
              } catch {
                setError("Playback error (decoder could not recover).");
              }
              return;
            }
            setError(
              "Playback error (codec or stream issue). If this is HEVC / AC-4, try a channel encoded as H.264 + AAC, or another quality level."
            );
            return;
          }

          if (data.type === Hls.ErrorTypes.MUX_ERROR || data.type === Hls.ErrorTypes.OTHER_ERROR) {
            hlsNetworkFatalStreak++;
            try {
              hls.startLoad();
            } catch {
              /* noop */
            }
            if (hlsNetworkFatalStreak <= 3) {
              setError(null);
              return;
            }
            setError(
              `Stream error (${data.type}${data.details ? `: ${data.details}` : ""}). The playlist or segments may be invalid or temporarily unavailable.`
            );
            return;
          }

          if (data.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) {
            setError("DRM / key system error — this stream may require authorization or a different player.");
            return;
          }

          setError(
            `Playback error (${data.type}${data.details ? `: ${data.details}` : ""}). Try another channel or ask your provider for a stable HLS feed.`
          );
        });
        hls.attachMedia(el);
        hls.loadSource(manifestSrc);
        setPlaybackMode(splitHlsViaLocalProxy ? "HLS · hls.js · split proxy" : "HLS · hls.js");
      } else if (canPlayNativeHls(el as HTMLVideoElement)) {
        el.src = url;
        el.addEventListener("loadedmetadata", onTracks, { once: true });
        setPlaybackMode("HLS · native");
      } else {
        setPlaybackMode("HLS · blocked");
        setError("HLS is not supported in this browser.");
        return;
      }
    } else if (channel.id.startsWith("radio-") && !isLikelyHls(url)) {
      if (!/^https?:\/\//i.test(url)) {
        setPlaybackMode("URL · blocked");
        setError("This URL scheme is not supported in the browser player (use http(s) streams).");
        return;
      }
      function onRadioLoadedMeta() {
        el.removeEventListener("error", onRadioError);
        onTracks();
      }
      function onRadioError() {
        el.removeEventListener("loadedmetadata", onRadioLoadedMeta);
        setPlaybackMode(null);
        setError("Could not play this radio stream URL in the browser.");
      }
      el.addEventListener("error", onRadioError, { once: true });
      el.addEventListener("loadedmetadata", onRadioLoadedMeta, { once: true });
      nativeErrCleanup = () => {
        el.removeEventListener("error", onRadioError);
        el.removeEventListener("loadedmetadata", onRadioLoadedMeta);
      };
      const radioPlay = recordTapPlayUrl?.trim() || url;
      setPlaybackMode(recordTapPlayUrl ? "Radio · record tap" : "Radio · native");
      el.src = radioPlay;
    } else if (isLikelyMpegTsOverHttp(url)) {
      if (!mpegts.isSupported()) {
        setPlaybackMode("MPEG-TS · blocked");
        setError(
          "This channel looks like MPEG-TS. This browser does not support the in-page TS player (mpegts.js). Try Chrome/Edge, or ask your provider for an HLS (m3u8) playlist."
        );
        return;
      }
      if (!bindMpegTsPlayer(url, recordTapPlayUrl)) {
        setPlaybackMode("MPEG-TS · blocked");
        setError("Could not start the MPEG-TS player in this browser.");
        return;
      }
      setPlaybackMode("MPEG-TS · mpegts.js");
    } else if (!/^https?:\/\//i.test(url)) {
      setPlaybackMode("URL · blocked");
      setError("This URL scheme is not supported in the browser player (use http(s) streams).");
      return;
    } else {
      /** Many IPTV URLs look like normal https links but are MPEG-TS; Firefox then shows a MIME error on a plain video src. Try native first, then mpegts.js. */
      function onNativeLoadedMeta() {
        el.removeEventListener("error", onNativeError);
        onTracks();
      }
      function onNativeError() {
        el.removeEventListener("loadedmetadata", onNativeLoadedMeta);
        el.removeAttribute("src");
        el.load();
        if (mpegts.isSupported() && bindMpegTsPlayer(url, recordTapPlayUrl)) {
          setPlaybackMode("MPEG-TS · mpegts.js");
          setError(null);
          void el.play().catch(() => {});
        } else {
          setPlaybackMode(null);
          setError(
            "This stream is not a format the browser can play directly (often MPEG-TS from output=mpegts). Firefox could not hand it off to the TS player. Try Chrome/Edge or ask your provider for HLS (m3u8)."
          );
        }
      }
      el.addEventListener("error", onNativeError, { once: true });
      el.addEventListener("loadedmetadata", onNativeLoadedMeta, { once: true });
      nativeErrCleanup = () => {
        el.removeEventListener("error", onNativeError);
        el.removeEventListener("loadedmetadata", onNativeLoadedMeta);
      };
      setPlaybackMode(recordTapPlayUrl ? "Native · record tap" : "Native · direct");
      const nativePlay = recordTapPlayUrl?.trim() || url;
      el.src = nativePlay;
    }

    if (!skipDefaultFinish) {
      el.addEventListener("addtrack", onTracks as EventListener);

      void el.play().catch(() => {
        /* autoplay policy — user can press play */
      });
    }

    return () => {
      effectLive = false;
      if (mpegtsRetryTimer != null) {
        clearTimeout(mpegtsRetryTimer);
        mpegtsRetryTimer = null;
      }
      nativeErrCleanup?.();
      el.removeEventListener("addtrack", onTracks as EventListener);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      mpegtsRef.current?.destroy();
      mpegtsRef.current = null;
      if (externalUrlRef.current) {
        URL.revokeObjectURL(externalUrlRef.current);
        externalUrlRef.current = null;
      }
    };
  }, [channel, refreshTextTracks, recordTapPlayUrl, streamProxyOrigin, splitIsolateNetwork, radioStreamReloadTick]);

  useEffect(() => {
    setPlayerChromeNotice(null);
  }, [channel?.id]);

  useEffect(() => {
    const v = mediaRef.current;
    if (!v) return;
    const vol = typeof volume === "number" && Number.isFinite(volume) ? volume : 1;
    const clamped = Math.min(1, Math.max(0, vol));
    if (mediaEqEnabled && radioEqWebAudioActive) {
      v.volume = 1;
      return;
    }
    v.volume = clamped;
  }, [volume, channel?.id, mediaEqEnabled, radioEqWebAudioActive]);

  useEffect(() => {
    const video = mediaRef.current;
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      const t = video.textTracks[i];
      if (t.kind === "subtitles" || t.kind === "captions") {
        t.mode = "disabled";
      }
    }
    if (selectedTrack === "off" || !ccEnabled) return;
    const m = /^native-(\d+)$/.exec(selectedTrack);
    if (!m) return;
    const idx = Number(m[1]);
    const t = video.textTracks[idx];
    if (t && (t.kind === "subtitles" || t.kind === "captions")) {
      t.mode = "showing";
    }
  }, [selectedTrack, ccEnabled, trackOptions]);

  const onSubtitleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !mediaRef.current) return;

    const video = mediaRef.current;
    video.querySelectorAll("track[data-iptv-external]").forEach((node) => node.remove());
    if (externalUrlRef.current) {
      URL.revokeObjectURL(externalUrlRef.current);
      externalUrlRef.current = null;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const isSrt = file.name.toLowerCase().endsWith(".srt");
      const vtt = isSrt ? srtToWebVtt(text) : text;
      const blob = new Blob([vtt], { type: "text/vtt" });
      const objectUrl = URL.createObjectURL(blob);
      externalUrlRef.current = objectUrl;

      const track = document.createElement("track");
      track.kind = "subtitles";
      track.label = file.name.replace(/\.[^.]+$/, "") || "Custom";
      track.src = objectUrl;
      track.default = true;
      track.setAttribute("data-iptv-external", "1");
      video.appendChild(track);

      refreshTextTracks();
      let lastSub = -1;
      for (let i = 0; i < video.textTracks.length; i++) {
        const t = video.textTracks[i];
        if (t.kind === "subtitles" || t.kind === "captions") lastSub = i;
      }
      if (lastSub >= 0) {
        setSelectedTrack(`native-${lastSub}`);
        setCcEnabled(true);
      }
    };
    reader.readAsText(file, "UTF-8");
  };

  const startRecording = useCallback(async () => {
    if (isLibraryChannel) return;
    if (!channel?.url?.trim() || !canStartRecording) return;
    setRecordErr(null);
    setRecordSavedPath(null);
    setRecordBusy(true);
    try {
      const dir = await window.iptv!.pickRecordDir();
      if (!dir) return;
      const hint = recordFileSuffixAndTapType(channel.url.trim(), channel.id);
      const out = await window.iptv!.startStreamRecord({
        url: channel.url.trim(),
        outDir: dir,
        filenameExt: hint.filenameExt,
        tapContentType: hint.tapContentType,
      });
      recordIdRef.current = out.id;
      flushSync(() => {
        setRecording(true);
        setRecordSavedPath(out.filePath);
        setRecordTapPlayUrl(out.playbackUrl ?? null);
      });
    } catch (e) {
      setRecordErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRecordBusy(false);
    }
  }, [channel, canStartRecording, isLibraryChannel]);

  const stopRecording = useCallback(async () => {
    const id = recordIdRef.current;
    if (!id || !window.iptv?.stopStreamRecord) return;
    setRecordBusy(true);
    try {
      await window.iptv.stopStreamRecord(id);
    } catch (e) {
      setRecordErr(e instanceof Error ? e.message : String(e));
    } finally {
      recordIdRef.current = null;
      setRecording(false);
      setRecordTapPlayUrl(null);
      setRecordBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!isLibraryChannel || !recording) return;
    void stopRecording();
  }, [isLibraryChannel, recording, stopRecording]);

  const canRevealRecordingInExplorer =
    typeof window !== "undefined" && typeof window.iptv?.showRecordInFolder === "function";

  const openRecordedFileInExplorer = useCallback(() => {
    const fp = recordSavedPath?.trim();
    if (!fp || !window.iptv?.showRecordInFolder) return;
    setRecordErr(null);
    void window.iptv.showRecordInFolder(fp).catch((e) => {
      setRecordErr(e instanceof Error ? e.message : String(e));
    });
  }, [recordSavedPath]);

  const openYoutubeForLocalMp3 = useCallback(async () => {
    if (!channel || !isLibraryChannel) return;
    const q = youtubeSearchQueryFromTrackName(channel.name);
    if (!q) {
      setYtErr("Could not build a search from this file name.");
      return;
    }
    setYtErr(null);
    setYtBusy(true);
    try {
      if (typeof window.iptv?.youtubeFirstVideoIdFromSearch === "function") {
        const r = await window.iptv.youtubeFirstVideoIdFromSearch(q);
        const id = typeof r?.videoId === "string" ? r.videoId.trim() : "";
        if (!/^[\w-]{11}$/.test(id)) {
          throw new Error("Unexpected response from YouTube search.");
        }
        const watchUrl = `https://www.youtube.com/watch?v=${id}`;
        window.open(watchUrl, "_blank", "noopener,noreferrer");
      } else {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        window.open(url, "_blank", "noopener,noreferrer");
        setYtErr("Opened a YouTube search tab. The desktop app can open the first matching video directly.");
      }
    } catch (e) {
      setYtErr(e instanceof Error ? e.message : String(e));
    } finally {
      setYtBusy(false);
    }
  }, [channel, isLibraryChannel]);

  const toggleLibraryPlayPause = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const skipLibraryBy = useCallback(
    (deltaSec: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const d = el.duration;
      const dur = typeof d === "number" && Number.isFinite(d) && d > 0 ? d : libAudioDurationSec ?? 0;
      const next = el.currentTime + deltaSec;
      const cap = dur > 1 ? dur : Number.POSITIVE_INFINITY;
      el.currentTime = Math.min(Math.max(0, next), cap);
      setLibSeekUiSec(el.currentTime);
    },
    [libAudioDurationSec]
  );

  const skipLibraryToStart = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = 0;
    setLibSeekUiSec(0);
  }, []);

  const reloadRadioStream = useCallback(() => {
    if (!isRadioChannel) return;
    setRadioStreamReloadTick((n) => n + 1);
    setPlayerChromeNotice("Reconnecting stream…");
    window.setTimeout(() => setPlayerChromeNotice(null), 1800);
  }, [isRadioChannel]);

  const copyRadioStreamUrl = useCallback(async () => {
    const u = channel?.url?.trim();
    if (!u || !isRadioChannel) return;
    try {
      await navigator.clipboard.writeText(u);
      setPlayerChromeNotice("Stream URL copied.");
      window.setTimeout(() => setPlayerChromeNotice(null), 2000);
    } catch {
      setPlayerChromeNotice("Could not copy — check clipboard permission or use the Edit menu.");
      window.setTimeout(() => setPlayerChromeNotice(null), 3500);
    }
  }, [channel?.url, isRadioChannel]);

  const openRadioStreamUrl = useCallback(() => {
    const u = channel?.url?.trim();
    if (!u || !isRadioChannel) return;
    if (!/^https?:\/\//i.test(u)) {
      setPlayerChromeNotice("Only http(s) URLs can open in a new tab.");
      window.setTimeout(() => setPlayerChromeNotice(null), 3000);
      return;
    }
    window.open(u, "_blank", "noopener,noreferrer");
  }, [channel?.url, isRadioChannel]);

  const renderVolumeEq = (extraWrapClass?: string) => {
    if (!onVolumeChange) return null;
    return (
      <div className={extraWrapClass ? `volume-eq-wrap ${extraWrapClass}` : "volume-eq-wrap"}>
        <div className="volume-popover-host" ref={volumePopoverRef}>
          <button
            type="button"
            className="volume-popover-trigger"
            aria-expanded={volumePopoverOpen}
            aria-haspopup="dialog"
            title="Volume"
            onClick={() => setVolumePopoverOpen((o) => !o)}
          >
            <span className="volume-popover-glyph" aria-hidden>
              ♪
            </span>
            <span className="volume-popover-pct">{Math.round(volume * 100)}%</span>
          </button>
          {volumePopoverOpen ? (
            <div className="volume-popover-panel" role="dialog" aria-label="Volume">
              <div className="volume-popover-panel-inner">
                <span className="volume-popover-title">Volume</span>
                <input
                  type="range"
                  className="volume-popover-slider"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  aria-valuetext={`${Math.round(volume * 100)} percent`}
                  onChange={(e) => onVolumeChange(Number(e.currentTarget.value))}
                />
                <span className="volume-popover-readout">{Math.round(volume * 100)}%</span>
              </div>
            </div>
          ) : null}
        </div>
        <RadioEqualizer
          mediaRef={mediaRef}
          eqEnabled={mediaEqEnabled}
          volume={volume}
          onWebAudioRoutingActive={setRadioEqWebAudioActive}
        />
      </div>
    );
  };

  return (
    <div className="player-root" ref={playerRootRef}>
      <div className="player-top">
        {!channel ? (
          <div className="player-placeholder">
            <strong>{paneLabel ? `No channel on ${paneLabel}` : "No channel selected."}</strong>
            <br />
            {paneLabel ? (
              <>
                Turn on <strong>Split view</strong> in the list header, choose <strong>Left</strong> or{" "}
                <strong>Right</strong> for the next click, then pick a channel.
              </>
            ) : (
              <>
                Pick a channel on the left, or load your provider’s <code>.m3u</code> playlist. MPEG-TS (typical for{" "}
                <code>output=mpegts</code>) is played via MSE; HLS uses <code>m3u8</code>. Some streams need HLS output
                from your provider instead.
              </>
            )}
          </div>
        ) : (
          <div className="video-wrap">
            <video
              ref={mediaRef}
              className="video-el"
              controls={!isRadioChannel}
              playsInline
              preload="auto"
            />
            {isRadioChannel ? (
              <>
                <div className="radio-on-air-badge" role="status" aria-live="polite">
                  <span
                    className={`radio-on-air-dot${!radioPlaying ? " on-air-dot--paused" : ""}`}
                    aria-hidden
                  />
                  Radio
                </div>
                <button
                  type="button"
                  className="radio-transport-btn"
                  onClick={() => {
                    const el = mediaRef.current;
                    if (!el) return;
                    if (el.paused) void el.play().catch(() => {});
                    else el.pause();
                  }}
                  aria-label={radioPlaying ? "Pause radio" : "Play radio"}
                  title={radioPlaying ? "Pause" : "Play"}
                >
                  {radioPlaying ? (
                    <svg className="radio-transport-icon" viewBox="0 0 18 18" width="18" height="18" aria-hidden>
                      <rect x="3" y="3" width="4" height="12" rx="0.5" fill="currentColor" />
                      <rect x="11" y="3" width="4" height="12" rx="0.5" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg className="radio-transport-icon" viewBox="0 0 18 18" width="18" height="18" aria-hidden>
                      <path d="M4 2 L16 9 L4 16 Z" fill="currentColor" />
                    </svg>
                  )}
                </button>
              </>
            ) : isLibraryChannel ? (
              <div className="library-on-air-badge" role="status" aria-live="polite">
                <span
                  className={`library-on-air-dot${libTransportPaused ? " on-air-dot--paused" : ""}`}
                  aria-hidden
                />
                Audio
              </div>
            ) : null}
            {channel &&
            isLikelyLocalMp3Channel(channel) &&
            !mp3LyricsHidden &&
            mp3Lyrics.kind !== "idle" ? (
              <div
                ref={mp3LyricsPanelRef}
                className={
                  "mp3-lyrics-panel" + (lyricsSpatialBox ? " mp3-lyrics-panel--spatial-fullscreen" : "")
                }
                style={
                  lyricsSpatialBox
                    ? {
                        position: "fixed",
                        top: lyricsSpatialBox.top,
                        left: lyricsSpatialBox.left,
                        width: lyricsSpatialBox.width,
                        height: lyricsSpatialBox.height,
                        zIndex: 50000,
                      }
                    : undefined
                }
                role="region"
                aria-label="Lyrics"
                aria-busy={mp3Lyrics.kind === "loading"}
              >
                <div className="mp3-lyrics-panel-head">
                  <span className="mp3-lyrics-panel-title">{lyricsPanelTitle}</span>
                  <div className="mp3-lyrics-panel-head-actions">
                    {mp3Lyrics.kind === "ready" && mp3Lyrics.data.pairs.length > 0 ? (
                      <LyricsTranslateMenu
                        busy={lyricsTranslateBusy}
                        activeTarget={lyricsTranslateTarget}
                        onSelectLanguage={(code) => void onLyricsTranslateLanguage(code)}
                      />
                    ) : null}
                    <button
                      type="button"
                      className="mp3-lyrics-hide"
                      onClick={() => void toggleLyricsFullscreen()}
                      aria-pressed={lyricsSpatialFullscreen}
                      aria-label={lyricsSpatialFullscreen ? "Exit full screen lyrics" : "Full screen lyrics"}
                      title={lyricsSpatialFullscreen ? "Exit full screen (Esc)" : "Full screen lyrics in this player"}
                    >
                      {lyricsSpatialFullscreen ? "Exit full screen" : "Full screen"}
                    </button>
                  </div>
                </div>
                {lyricsTranslateErr ? (
                  <p className="mp3-lyrics-translate-err" role="alert">
                    {lyricsTranslateErr}
                  </p>
                ) : null}
                {lyricsTranslateHint && !lyricsTranslateErr ? (
                  <p className="mp3-lyrics-translate-status">{lyricsTranslateHint}</p>
                ) : null}
                {lyricsDisplayMeta ? (
                  <header className="mp3-lyrics-track-meta" aria-label="Track from file tags">
                    {lyricsDisplayMeta.artist ? (
                      <p className="mp3-lyrics-track-artist">{lyricsDisplayMeta.artist}</p>
                    ) : null}
                    {lyricsDisplayMeta.title ? (
                      <p className="mp3-lyrics-track-title">{lyricsDisplayMeta.title}</p>
                    ) : null}
                    {lyricsDisplayMeta.album ? (
                      <p className="mp3-lyrics-track-album">{lyricsDisplayMeta.album}</p>
                    ) : null}
                    {lyricsDisplayMeta.fromTags ? (
                      <p className="mp3-lyrics-track-source">From file tags</p>
                    ) : null}
                  </header>
                ) : null}
                {mp3Lyrics.kind === "error" ? (
                  <div className="mp3-lyrics-err-body">{mp3Lyrics.message}</div>
                ) : null}
                {mp3Lyrics.kind === "ready" ? (
                  <div className="mp3-lyrics-body">
                    {mp3Lyrics.data.pairs.length === 0 ? (
                      <p className="mp3-lyrics-empty">No lyric lines for this title.</p>
                    ) : (
                      lyricsDisplayPairs.map((p, idx) => {
                        const same = p.orig.trim() === p.en.trim();
                        return same ? (
                          <p key={idx} className="mp3-lyrics-line mp3-lyrics-line--single">
                            {p.orig}
                          </p>
                        ) : (
                          <div key={idx} className="mp3-lyrics-stanza">
                            <p className="mp3-lyrics-line mp3-lyrics-line--orig">{p.orig}</p>
                            <p
                              className="mp3-lyrics-line mp3-lyrics-line--en"
                              title={lyricsTranslateLangLabel ?? undefined}
                            >
                              {p.en}
                            </p>
                          </div>
                        );
                      })
                    )}
                    {mp3Lyrics.data.pairs.length > 0 &&
                    (songMeaningLoading ||
                      mp3Lyrics.data.songMeaning ||
                      mp3Lyrics.data.songMeaningError) ? (
                      <section
                        ref={songMeaningSectionRef}
                        className="mp3-lyrics-meaning"
                        aria-label="Song meaning"
                      >
                        <h3 className="mp3-lyrics-meaning-title">What this song is about</h3>
                        {songMeaningLoading ? (
                          <p className="mp3-lyrics-meaning-loading">Asking the LLM…</p>
                        ) : null}
                        {!songMeaningLoading && mp3Lyrics.data.songMeaning ? (
                          <p className="mp3-lyrics-meaning-body">{mp3Lyrics.data.songMeaning}</p>
                        ) : null}
                        {!songMeaningLoading && mp3Lyrics.data.songMeaningError ? (
                          <p className="mp3-lyrics-meaning-error" role="status">
                            {mp3Lyrics.data.songMeaningError}
                          </p>
                        ) : null}
                      </section>
                    ) : null}
                    {mp3Lyrics.data.pairs.length > 0 &&
                    (mp3Lyrics.data.lyricsLlmModel ||
                      mp3Lyrics.data.songMeaningLlmModel ||
                      mp3Lyrics.data.songMeaningError) ? (
                      <footer className="mp3-lyrics-llm-usage" aria-label="LLM models used">
                        <p className="mp3-lyrics-llm-usage-title">LLM (Audio → Lyrics translation)</p>
                        {mp3Lyrics.data.lyricsLlmModel && mp3Lyrics.data.lyricsLlmHost ? (
                          <p className="mp3-lyrics-llm-usage-line">
                            Lyrics (English):{" "}
                            {formatLlmUsageLine(
                              mp3Lyrics.data.lyricsLlmPurpose || "lyrics translation",
                              mp3Lyrics.data.lyricsLlmModel,
                              mp3Lyrics.data.lyricsLlmHost
                            )}
                          </p>
                        ) : (
                          <p className="mp3-lyrics-llm-usage-line mp3-lyrics-llm-usage-line--muted">
                            Lyrics: LRCLIB original text; English via free translators or same-language
                            (no LLM for translation on this track).
                          </p>
                        )}
                        {mp3Lyrics.data.songMeaningLlmModel && mp3Lyrics.data.songMeaningLlmHost ? (
                          <p className="mp3-lyrics-llm-usage-line">
                            Song meaning:{" "}
                            {formatLlmUsageLine(
                              mp3Lyrics.data.songMeaningLlmPurpose || "song meaning",
                              mp3Lyrics.data.songMeaningLlmModel,
                              mp3Lyrics.data.songMeaningLlmHost
                            )}
                            {mp3Lyrics.data.songMeaning
                              ? " · loaded"
                              : mp3Lyrics.data.songMeaningError
                                ? " · failed"
                                : ""}
                          </p>
                        ) : null}
                      </footer>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {channel && !isLibraryChannel ? (
        <div className="player-now-playing" aria-label="Now playing">
          <div className="player-now-playing-inner">
            {channel.logo?.trim() && !underLogoFailed ? (
              <img
                className="player-now-playing-logo"
                src={channel.logo.trim()}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setUnderLogoFailed(true)}
              />
            ) : (
              <span className="player-now-playing-logo player-now-playing-logo--placeholder" aria-hidden>
                {isRadioChannel ? "♪" : "TV"}
              </span>
            )}
            <div className="player-now-playing-text">
              <div className="player-now-playing-name">
                {isRadioChannel ? <span className="radio-inline-tag">Radio</span> : null}
                {isLibraryChannel ? <span className="library-inline-tag">Local audio</span> : null}
                {isLocalVideoChannel ? <span className="local-video-inline-tag">Local video</span> : null}
                <span className="player-now-playing-title-text">{channel.name}</span>
              </div>
              {channel.group?.trim() ? (
                <div className="player-now-playing-group">{channel.group.trim()}</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="player-chrome">
        {channel ? (
          <>
            <div className={`now-row${showRecordChrome ? " now-row--with-actions" : ""}`}>
              <div className="now-row-main">
                {paneLabel ? (
                  <span className="pane-label" title="Player pane">
                    {paneLabel}
                  </span>
                ) : null}
                {playbackMode ? (
                  <span
                    className={`playback-badge${playbackMode.includes("blocked") ? " playback-badge--warn" : ""}`}
                    title="How this stream is played: HLS via hls.js, HLS via the browser, MPEG-TS via mpegts.js (MSE), or a direct URL in the native video element."
                  >
                    {playbackMode}
                  </span>
                ) : null}
              </div>
              {showRecordChrome ? (
                <div className="now-row-actions">
                  {recording ? (
                    <button
                      type="button"
                      className="rec-btn rec-btn--stop"
                      disabled={recordBusy}
                      title="Stop recording"
                      onClick={() => void stopRecording()}
                    >
                      ■
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rec-btn"
                      disabled={recordBusy || !canStartRecording}
                      title={recordButtonTitle}
                      onClick={() => void startRecording()}
                    >
                      REC
                    </button>
                  )}
                </div>
              ) : null}
            </div>
            <div className="buffer-stats" title="Buffered seconds ahead, buffer fill rate (s/s), optional HLS level bitrate">
              {bufferLine}
            </div>
            {isLibraryChannel ? (
              <>
                <div className="library-seek-row" aria-label="Playback position">
                  <span className="library-seek-label">Position</span>
                  <div className="library-seek-main">
                    <input
                      type="range"
                      className="library-seek-slider"
                      min={0}
                      max={
                        libAudioDurationSec != null && libAudioDurationSec > 1.5
                          ? libAudioDurationSec
                          : 1
                      }
                      step={0.1}
                      disabled={!(libAudioDurationSec != null && libAudioDurationSec > 1.5)}
                      value={
                        libAudioDurationSec != null && libAudioDurationSec > 1.5
                          ? Math.min(Math.max(0, libSeekUiSec), libAudioDurationSec)
                          : 0
                      }
                      aria-valuetext={`${formatPlaybackClock(libSeekUiSec)} of ${
                        libAudioDurationSec != null && libAudioDurationSec > 1.5
                          ? formatPlaybackClock(libAudioDurationSec)
                          : "unknown"
                      }`}
                      onInput={(e) => {
                        const el = mediaRef.current;
                        const dur = libAudioDurationSec;
                        if (!el || dur == null || !(dur > 1.5)) return;
                        const v = Number(e.currentTarget.value);
                        if (!Number.isFinite(v)) return;
                        el.currentTime = Math.min(Math.max(0, v), dur);
                        setLibSeekUiSec(el.currentTime);
                      }}
                    />
                    {librarySeekScaleTicks ? (
                      <div className="library-seek-scale" aria-hidden>
                        {librarySeekScaleTicks.map((sec, i) => (
                          <span key={i} className="library-seek-scale-tick">
                            {formatPlaybackClockHMS(sec)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="library-seek-scale library-seek-scale--placeholder" aria-hidden>
                        —
                      </div>
                    )}
                  </div>
                  <span className="library-seek-times">
                    {formatPlaybackClock(libSeekUiSec)} /{" "}
                    {libAudioDurationSec != null && libAudioDurationSec > 1.5
                      ? formatPlaybackClock(libAudioDurationSec)
                      : "—"}
                  </span>
                </div>
                <div className="library-controls-bar">
                  <div className="library-transport-row library-transport-row--compact" aria-label="Playback controls">
                    <button
                      type="button"
                      className="library-transport-btn library-transport-btn--compact"
                      title="Back 15 seconds"
                      aria-label="Back 15 seconds"
                      onClick={() => skipLibraryBy(-15)}
                    >
                      <span className="library-transport-skip" aria-hidden>
                        −15s
                      </span>
                    </button>
                    <button
                      type="button"
                      className="library-transport-btn library-transport-btn--compact library-transport-btn--play library-transport-btn--play--compact"
                      title={libTransportPaused ? "Play" : "Pause"}
                      aria-label={libTransportPaused ? "Play" : "Pause"}
                      onClick={() => void toggleLibraryPlayPause()}
                    >
                      {libTransportPaused ? (
                        <svg className="library-transport-icon" viewBox="0 0 18 18" width="14" height="14" aria-hidden>
                          <path d="M4 2 L16 9 L4 16 Z" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg className="library-transport-icon" viewBox="0 0 18 18" width="14" height="14" aria-hidden>
                          <rect x="3" y="3" width="4" height="12" rx="0.5" fill="currentColor" />
                          <rect x="11" y="3" width="4" height="12" rx="0.5" fill="currentColor" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className="library-transport-btn library-transport-btn--compact"
                      title="Forward 15 seconds"
                      aria-label="Forward 15 seconds"
                      onClick={() => skipLibraryBy(15)}
                    >
                      <span className="library-transport-skip" aria-hidden>
                        +15s
                      </span>
                    </button>
                    {renderVolumeEq("volume-eq-wrap--library-inline")}
                  </div>
                </div>
              </>
            ) : null}
            {channel && !isLibraryChannel ? (
              <div className="now-url" title={channel.url}>
                {channel.url}
              </div>
            ) : null}
            {showRecordChrome && recordSavedPath ? (
              canRevealRecordingInExplorer ? (
                <button
                  type="button"
                  className="record-path record-path--compact record-path--link"
                  title={`${recordSavedPath}\nClick to open this folder in File Explorer and select the file`}
                  onClick={openRecordedFileInExplorer}
                >
                  {recordSavedPath.length > 88 ? `…${recordSavedPath.slice(-84)}` : recordSavedPath}
                </button>
              ) : (
                <div className="record-path record-path--compact" title={recordSavedPath}>
                  {recordSavedPath.length > 88 ? `…${recordSavedPath.slice(-84)}` : recordSavedPath}
                </div>
              )
            ) : null}
            {showRecordChrome && recordErr ? <div className="record-err record-err--compact">{recordErr}</div> : null}
            {showRecordChrome && !canStartRecording && !recording && (!hasDesktopRecordApi || !streamOkForRecord) ? (
              <p className="record-hint record-hint--inline">
                {!hasDesktopRecordApi
                  ? "REC needs the RJ IPTV and Online Radio Player desktop build."
                  : isLikelyHls(channel.url)
                    ? "REC cannot save HLS (.m3u8) as one continuous raw file. Use a direct stream URL when available."
                    : "REC needs http(s) and a continuous stream (MPEG-TS or direct audio)."}
              </p>
            ) : null}
            {onVolumeChange && !isLibraryChannel ? renderVolumeEq() : null}
            {error ? <div className="error-banner">{error}</div> : null}
            {ytErr ? <div className="yt-search-err">{ytErr}</div> : null}
            {playerChromeNotice ? <div className="player-chrome-notice">{playerChromeNotice}</div> : null}
            {isLibraryChannel ? (
              <div className="library-audio-toolbar" role="toolbar" aria-label="Track tools">
                <div className="library-audio-toolbar__group library-audio-toolbar__group--primary">
                  <button
                    type="button"
                    className="library-audio-tool-btn library-audio-tool-btn--yt"
                    disabled={
                      ytBusy || youtubeSearchQueryFromTrackName(channel.name).trim().length < 2
                    }
                    aria-busy={ytBusy}
                    title="Search from the file name; desktop can open the first YouTube result in a new window."
                    onClick={() => void openYoutubeForLocalMp3()}
                  >
                    {ytBusy ? "…" : "YouTube"}
                  </button>
                  {isLikelyLocalMp3Channel(channel) ? (
                    <>
                      <button
                        type="button"
                        className="library-audio-tool-btn"
                        disabled={mp3Lyrics.kind === "loading"}
                        title="LRCLIB + optional translation. Overwrites saved lyrics for this track if new lyrics are found."
                        onClick={() => {
                          skipLyricsCacheOnceRef.current = true;
                          setMp3LyricsHidden(false);
                          setMp3LyricsRefresh((n) => n + 1);
                        }}
                      >
                        {mp3Lyrics.kind === "loading" ? "Lyrics…" : "Refresh lyrics"}
                      </button>
                      {!mp3LyricsHidden && mp3Lyrics.kind !== "idle" ? (
                        <button
                          type="button"
                          className="library-audio-tool-btn"
                          onClick={hideLyricsPanel}
                          title="Hide the lyrics panel"
                        >
                          Hide lyrics
                        </button>
                      ) : mp3LyricsHidden && mp3Lyrics.kind !== "idle" ? (
                        <button
                          type="button"
                          className="library-audio-tool-btn"
                          onClick={() => setMp3LyricsHidden(false)}
                          title="Show the lyrics panel"
                        >
                          Show lyrics
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="library-audio-toolbar__group library-audio-toolbar__group--secondary">
                  <button
                    type="button"
                    className="library-audio-tool-btn"
                    onClick={() => skipLibraryToStart()}
                    title="Jump to the beginning of this track"
                  >
                    Start over
                  </button>
                  <label className="library-audio-speed">
                    <span className="library-audio-speed__text">Speed</span>
                    <select
                      className="library-audio-speed__select"
                      value={libPlaybackRate}
                      onChange={(e) => setLibPlaybackRate(Number(e.currentTarget.value))}
                      aria-label="Playback speed"
                    >
                      <option value={0.75}>0.75×</option>
                      <option value={1}>1×</option>
                      <option value={1.25}>1.25×</option>
                      <option value={1.5}>1.5×</option>
                      <option value={2}>2×</option>
                    </select>
                  </label>
                </div>
              </div>
            ) : isRadioChannel ? (
              <div className="radio-chrome-toolbar" role="toolbar" aria-label="Stream tools">
                <button
                  type="button"
                  className="library-audio-tool-btn"
                  onClick={() => void copyRadioStreamUrl()}
                  disabled={!channel?.url?.trim()}
                  title="Copy the station stream URL to the clipboard"
                >
                  Copy stream URL
                </button>
                <button
                  type="button"
                  className="library-audio-tool-btn"
                  onClick={openRadioStreamUrl}
                  disabled={!/^https?:\/\//i.test(channel?.url?.trim() ?? "")}
                  title="Open the stream URL in your default browser"
                >
                  Open stream
                </button>
                <button
                  type="button"
                  className="library-audio-tool-btn"
                  onClick={reloadRadioStream}
                  disabled={!channel?.url?.trim()}
                  title="Tear down the player and reconnect (useful after a stall)"
                >
                  Reload stream
                </button>
              </div>
            ) : (
              <div className="controls-row">
                <input
                  ref={subFileRef}
                  type="file"
                  accept=".vtt,.srt,text/vtt,application/x-subrip"
                  className="hidden-input"
                  onChange={onSubtitleFile}
                />
                <button type="button" className="ctrl-btn" onClick={() => subFileRef.current?.click()}>
                  Load subtitles (.vtt / .srt)
                </button>
                <label className="cc-toggle">
                  <input type="checkbox" checked={ccEnabled} onChange={(e) => setCcEnabled(e.target.checked)} />
                  Show CC
                </label>
                <select
                  className="track-select"
                  value={selectedTrack}
                  onChange={(e) => setSelectedTrack(e.target.value)}
                  disabled={trackOptions.length === 0}
                  aria-label="Subtitle track"
                >
                  <option value="off">Subtitles: off</option>
                  {trackOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
