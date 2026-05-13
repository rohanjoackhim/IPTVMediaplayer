import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
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
import { RadioEqualizer } from "./RadioEqualizer";
import "./VideoPlayer.css";

function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    video.canPlayType("application/x-mpegURL") !== "";
}

export interface VideoPlayerProps {
  channel: Channel | null;
  isChannelFavorite: boolean;
  onToggleChannelFavorite: () => void;
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
  | "URL · blocked";

export function VideoPlayer({
  channel,
  isChannelFavorite,
  onToggleChannelFavorite,
  volume = 1,
  onVolumeChange,
  paneLabel,
  recordable = true,
  streamProxyOrigin,
  splitIsolateNetwork = false,
}: VideoPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
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
  /** Radio EQ Web Audio path: keep `<video>` at unity gain and use GainNode only (see RadioEqualizer). */
  const [radioEqWebAudioActive, setRadioEqWebAudioActive] = useState(false);

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

  useEffect(() => {
    setUnderLogoFailed(false);
  }, [channel?.id, channel?.logo]);

  useEffect(() => {
    if (!isRadioChannel) setRadioEqWebAudioActive(false);
  }, [isRadioChannel]);

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

  const canStartRecording = recordable && streamOkForRecord && hasDesktopRecordApi;

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
        persistPosition();
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

    el.addEventListener("addtrack", onTracks as EventListener);

    void el.play().catch(() => {
      /* autoplay policy — user can press play */
    });

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
  }, [channel, refreshTextTracks, recordTapPlayUrl, streamProxyOrigin, splitIsolateNetwork]);

  useEffect(() => {
    const v = mediaRef.current;
    if (!v) return;
    const vol = typeof volume === "number" && Number.isFinite(volume) ? volume : 1;
    const clamped = Math.min(1, Math.max(0, vol));
    if (isRadioChannel && radioEqWebAudioActive) {
      v.volume = 1;
      return;
    }
    v.volume = clamped;
  }, [volume, channel?.id, isRadioChannel, radioEqWebAudioActive]);

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
  }, [channel, canStartRecording]);

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

  return (
    <div className="player-root">
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
                  <span className="radio-on-air-dot" aria-hidden />
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
                <span className="library-on-air-dot" aria-hidden />
                Audio
              </div>
            ) : null}
          </div>
        )}
      </div>

      {channel ? (
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
                {isRadioChannel || isLibraryChannel ? "♪" : "TV"}
              </span>
            )}
            <div className="player-now-playing-text">
              <div className="player-now-playing-name">
                {isRadioChannel ? <span className="radio-inline-tag">Radio</span> : null}
                {isLibraryChannel ? <span className="library-inline-tag">Local audio</span> : null}
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
            <div className="now-row now-row--with-actions">
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
              {recordable ? (
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
            <div className="now-url" title={channel.url}>
              {channel.url}
            </div>
            {recordable && recordSavedPath ? (
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
            {recordable && recordErr ? <div className="record-err record-err--compact">{recordErr}</div> : null}
            {recordable && !canStartRecording && !recording && (!hasDesktopRecordApi || !streamOkForRecord) ? (
              <p className="record-hint record-hint--inline">
                {!hasDesktopRecordApi
                  ? "REC needs the RJ IPTV and Online Radio Player desktop build."
                  : isLikelyHls(channel.url)
                    ? "REC cannot save HLS (.m3u8) as one continuous raw file. Use a direct stream URL when available."
                    : "REC needs http(s) and a continuous stream (MPEG-TS or direct audio)."}
              </p>
            ) : null}
            {onVolumeChange ? (
              <div className="volume-eq-wrap">
                <div className="volume-row">
                  <label className="volume-label">
                    <span>Volume</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={(e) => onVolumeChange(Number(e.target.value))}
                      aria-label="Volume"
                    />
                    <span className="volume-value">{Math.round(volume * 100)}%</span>
                  </label>
                </div>
                <RadioEqualizer
                  mediaRef={mediaRef}
                  isRadio={isRadioChannel}
                  volume={volume}
                  onWebAudioRoutingActive={setRadioEqWebAudioActive}
                />
              </div>
            ) : null}
            {error ? <div className="error-banner">{error}</div> : null}
            <div className="controls-row">
              <button
                type="button"
                className={`ctrl-btn fav-channel-btn${isChannelFavorite ? " fav-channel-btn--on" : ""}`}
                onClick={onToggleChannelFavorite}
                aria-pressed={isChannelFavorite}
                title={
                  isChannelFavorite
                    ? "Remove this channel from favorites"
                    : "Add this channel to favorites (same as ★ in the list)"
                }
              >
                {isChannelFavorite ? "★ Favorited" : "☆ Favorite this channel"}
              </button>
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
          </>
        ) : null}
      </div>
    </div>
  );
}
