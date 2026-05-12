import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import type { Channel } from "../types";
import { isLikelyHls, isLikelyMpegTsOverHttp } from "../utils/streamKind";
import { srtToWebVtt } from "../utils/srtToWebVtt";
import "./VideoPlayer.css";

function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    video.canPlayType("application/x-mpegURL") !== "";
}

export interface VideoPlayerProps {
  channel: Channel | null;
  isChannelFavorite: boolean;
  onToggleChannelFavorite: () => void;
}

interface TrackOption {
  id: string;
  label: string;
  index: number;
}

type MpegtsPlayer = ReturnType<typeof mpegts.createPlayer>;

/** Shown next to the channel name so you can see how the stream is being decoded. */
export type PlaybackModeLabel =
  | "HLS · hls.js"
  | "HLS · native"
  | "HLS · blocked"
  | "MPEG-TS · mpegts.js"
  | "MPEG-TS · blocked"
  | "Native · direct"
  | "URL · blocked";

export function VideoPlayer({ channel, isChannelFavorite, onToggleChannelFavorite }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const externalUrlRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackMode, setPlaybackMode] = useState<PlaybackModeLabel | null>(null);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string>("off");
  const [ccEnabled, setCcEnabled] = useState(true);
  const subFileRef = useRef<HTMLInputElement>(null);

  const refreshTextTracks = useCallback(() => {
    const video = videoRef.current;
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
    const video = videoRef.current;
    if (!video) return;

    hlsRef.current?.destroy();
    hlsRef.current = null;
    mpegtsRef.current?.destroy();
    mpegtsRef.current = null;
    if (externalUrlRef.current) {
      URL.revokeObjectURL(externalUrlRef.current);
      externalUrlRef.current = null;
    }
    video.removeAttribute("src");
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

    const bindMpegTsPlayer = (streamUrl: string): boolean => {
      if (!mpegts.isSupported()) return false;
      try {
        mpegtsRef.current?.destroy();
        mpegtsRef.current = null;
        const player = mpegts.createPlayer(
        {
          type: "mse",
          isLive: true,
          url: streamUrl,
          cors: true,
        },
        {
          enableWorker: false,
          /* Stash buffers network jitter; false caused frequent rebuffer on IPTV. */
          enableStashBuffer: true,
          stashInitialSize: 1024 * 1024,
          /* Latency chasing adjusts playback often and can feel like a stall every few seconds. */
          liveBufferLatencyChasing: false,
          liveSync: false,
          lazyLoad: false,
        }
      );
      mpegtsRef.current = player;
      player.attachMediaElement(el);
      player.on(mpegts.Events.MEDIA_INFO, onTracks);
      player.on(mpegts.Events.ERROR, (...args: unknown[]) => {
        const [type, detail] = args;
        setError(
          `Stream error (${String(type)}${detail != null ? `: ${String(detail)}` : ""}). If the channel still fails, the broadcaster may use a codec this browser cannot decode (e.g. HEVC), or the server may block web playback (CORS).`
        );
      });
      player.load();
      return true;
      } catch {
        mpegtsRef.current = null;
        return false;
      }
    };

    let nativeErrCleanup: (() => void) | null = null;

    if (isLikelyHls(url)) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWebVTT: true,
          renderTextTracksNatively: true,
          lowLatencyMode: false,
          maxBufferLength: 45,
          maxMaxBufferLength: 120,
          maxBufferHole: 0.5,
          liveSyncDurationCount: 4,
          liveMaxLatencyDurationCount: 14,
        });
        hlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, onTracks);
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, onTracks);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            setError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "Network error (stream unreachable or CORS)." : "Playback error.");
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          }
        });
        setPlaybackMode("HLS · hls.js");
      } else if (canPlayNativeHls(el)) {
        el.src = url;
        el.addEventListener("loadedmetadata", onTracks, { once: true });
        setPlaybackMode("HLS · native");
      } else {
        setPlaybackMode("HLS · blocked");
        setError("HLS is not supported in this browser.");
        return;
      }
    } else if (isLikelyMpegTsOverHttp(url)) {
      if (!mpegts.isSupported()) {
        setPlaybackMode("MPEG-TS · blocked");
        setError(
          "This channel looks like MPEG-TS. This browser does not support the in-page TS player (mpegts.js). Try Chrome/Edge, or ask your provider for an HLS (m3u8) playlist."
        );
        return;
      }
      if (!bindMpegTsPlayer(url)) {
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
        if (mpegts.isSupported() && bindMpegTsPlayer(url)) {
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
      setPlaybackMode("Native · direct");
      el.src = url;
    }

    el.addEventListener("addtrack", onTracks as EventListener);

    void el.play().catch(() => {
      /* autoplay policy — user can press play */
    });

    return () => {
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
  }, [channel, refreshTextTracks]);

  useEffect(() => {
    const video = videoRef.current;
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
    if (!file || !videoRef.current) return;

    const video = videoRef.current;
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

  return (
    <div className="player-root">
      <div className="player-top">
        {!channel ? (
          <div className="player-placeholder">
            <strong>No channel selected.</strong>
            <br />
            Pick a channel on the left, or load your provider’s <code>.m3u</code> playlist. MPEG-TS (typical for{" "}
            <code>output=mpegts</code>) is played via MSE; HLS uses <code>m3u8</code>. Some streams need HLS output from
            your provider instead.
          </div>
        ) : (
          <div className="video-wrap">
            <video ref={videoRef} className="video-el" controls playsInline preload="auto" />
          </div>
        )}
      </div>

      <div className="player-chrome">
        {channel ? (
          <>
            <div className="now-row">
              <div className="now-title">{channel.name}</div>
              {playbackMode ? (
                <span
                  className={`playback-badge${playbackMode.includes("blocked") ? " playback-badge--warn" : ""}`}
                  title="How this stream is played: HLS via hls.js, HLS via the browser, MPEG-TS via mpegts.js (MSE), or a direct URL in the native video element."
                >
                  {playbackMode}
                </span>
              ) : null}
            </div>
            <div className="now-url" title={channel.url}>
              {channel.url}
            </div>
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
