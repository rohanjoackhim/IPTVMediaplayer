import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import Hls, { FetchLoader } from "hls.js";
import mpegts from "mpegts.js";
import type { Channel } from "../types";
import {
  isLikelyHls,
  isLikelyMpegTsOverHttp,
  isLikelyProgressiveVideoUrl,
  isMatroskaUrl,
  needsDesktopFfmpegPlayback,
} from "../utils/streamKind";
import { mpegtsIptvConfig, streamRefererForUrl } from "../utils/iptvStreamHeaders";
import { isAlreadyProxiedStreamUrl, proxiedStreamUrl, shouldUseStreamProxy } from "../utils/proxiedStreamUrl";
import {
  canRecordRawHttpStream,
  isPodcastChannelId,
  isRadioStationChannelId,
  recordFileSuffixAndTapType,
} from "../utils/recordableStream";
import { formatBufferStatsLine, getBufferedAheadSec } from "../utils/mediaBufferedStats";
import { clearAudioResume, loadAudioResumeSeconds, saveAudioResumeSeconds } from "../utils/audioResumeStorage";
import { clearVideoResume, loadVideoResumeSeconds, saveVideoResumeSeconds } from "../utils/localVideoResumeStorage";
import { mimeHintForLocalVideoUrl } from "../utils/localVideoMime";
import {
  getLibraryLyricsCache,
  getLibraryLyricsTranslationCache,
  putLibraryLyricsTranslationCache,
} from "../utils/audioLibraryDb";
import { isLikelyLocalMp3Channel, youtubeSearchQueryFromTrackName } from "../utils/youtubeSearchFromLocalTitle";
import {
  enrichLocalMp3LyricsWithSongMeaning,
  fetchBilingualLyricsForLocalMp3,
  fetchDeepSeekLyricsForLocalMp3,
  fetchGeminiLyricsForLocalMp3,
  isUsableSavedLyricsCache,
  mapCachedLibraryLyricsToResult,
  saveLocalMp3LyricsResultToCache,
  type LyricLinePair,
  type LocalMp3LyricsResult,
} from "../utils/localMp3LyricsPipeline";
import { createLyricsJsonFetcher } from "../utils/lyricsJsonFetch";
import { sanitizeEpubMediaHtml } from "../utils/sanitizeEpubMediaHtml";
import { formatLlmUsageLine } from "../utils/lyricsLlmEndpointLabel";
import { labelForLyricsTargetCode } from "../utils/lyricsTargetLanguages";
import { translateLineBatchesToLanguage } from "../utils/translateLyricsLines";
import {
  resolveTrackMetadataFromLibrary,
  type TrackFileMetadata,
} from "../utils/resolveTrackMetadata";
import { getAudioLibraryTrackById, getEbookLibraryItemById } from "../utils/audioLibraryDb";
import { loadPdfJs } from "../utils/pdfJsLoader";
import { LyricsTranslateMenu } from "./LyricsTranslateMenu";
import { AnchoredPopover } from "./AnchoredPopover";
import { RadioEqualizer } from "./RadioEqualizer";
import {
  ensureElementPlaybackAudible,
  handoffEqScope,
  releaseEqForMediaElement,
} from "../utils/eqAudioGraph";
import { eqPageScopeForChannel } from "../utils/eqScopeSettings";
import {
  canUseRadioLiveCaptions,
  startRadioLiveCaptions,
  type RadioCaptionSegment,
  type RadioLiveCaptionsController,
} from "../utils/radioLiveCaptions";
import { RadioLiveCaptionsPanel } from "./RadioLiveCaptionsPanel";
import "./VideoPlayer.css";
import "./LyricsTranslateMenu.css";
import "./RadioLiveCaptionsPanel.css";

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
  /** Split view: keep video panes equal height by capping/scrolling the chrome block below the video. */
  inSplitView?: boolean;
  /** Fires when a local IndexedDB library track (`blob:` + `libraryTrackId`) finishes naturally. */
  onLocalLibraryAudioEnded?: (info: { pane: "L" | "R"; channelId: string }) => void;
  /** Notifies the app shell so it can show a global recording indicator while browsing elsewhere. */
  onRecordingStatusChange?: (recording: boolean) => void;
  /** Compact layout: TV strip dock or reader-focused chrome. */
  layoutMode?: "default" | "compactTvDock" | "compactReader";
}

interface TrackOption {
  id: string;
  label: string;
  index: number;
}

interface EbookSpeechBoundary {
  ebookId: string;
  chunkIndex: number;
  pageIndex?: number;
  charIndex: number;
  charLength?: number;
}

interface EbookTtsActiveDetail {
  ebookId: string;
  active: boolean;
}

const EBOOK_SPEECH_EVENT = "iptv-ebook-speech-boundary";
const EBOOK_TTS_ACTIVE_EVENT = "iptv-ebook-tts-active";
const EBOOK_START_EVENT = "iptv-ebook-start-at";
const EBOOK_OCR_TEXT_EVENT = "iptv-ebook-ocr-text";
const LIBRARY_AUDIO_TOGGLE_EVENT = "iptv-library-audio-toggle";
const LIBRARY_AUDIO_STATE_EVENT = "iptv-library-audio-state";
const LIBRARY_CLEARED_EVENT = "iptv-library-cleared";
const MEDIA_PLAYBACK_TOGGLE_EVENT = "iptv-media-playback-toggle";
const MEDIA_PLAYBACK_STATE_EVENT = "iptv-media-playback-state";

type EbookPageNavUnit = "page" | "chapter" | "part";

type EbookPageNav = {
  current: number;
  total: number;
  unit: EbookPageNavUnit;
  label?: string;
};

type EbookPageChangeMeta = {
  unit?: EbookPageNavUnit;
  label?: string;
};

function ebookPageNavUnitFromFormat(format: Channel["ebookFormat"]): EbookPageNavUnit {
  if (format === "epub") return "chapter";
  if (format === "pdf") return "page";
  return "part";
}

function ebookReadingLabel(unit: EbookPageNavUnit, current: number, total: number): string {
  const noun = unit === "chapter" ? "chapter" : unit === "part" ? "part" : "page";
  return `Reading ${noun} ${current} of ${total}`;
}

function splitEbookText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const sentences = cleaned.match(/[^.!?。！？]+[.!?。！？"]*|[^.!?。！？]+$/g) ?? [cleaned];
  const chunks: string[] = [];
  let cur = "";
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((cur + " " + s).trim().length <= 520) {
      cur = (cur + " " + s).trim();
      continue;
    }
    if (cur) chunks.push(cur);
    if (s.length <= 520) {
      cur = s;
      continue;
    }
    for (let i = 0; i < s.length; i += 520) chunks.push(s.slice(i, i + 520));
    cur = "";
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function ebookHighlightRange(chunk: string, boundary: EbookSpeechBoundary | null): { start: number; end: number } | null {
  if (!boundary) return null;
  const start = Math.max(0, Math.min(boundary.charIndex, chunk.length));
  let end =
    typeof boundary.charLength === "number" && boundary.charLength > 0
      ? Math.min(chunk.length, start + boundary.charLength)
      : start;
  if (end <= start) {
    while (end < chunk.length && /\s/.test(chunk[end] ?? "")) end++;
    while (end < chunk.length && !/\s/.test(chunk[end] ?? "")) end++;
  }
  return end > start ? { start, end } : null;
}

function textOffsetFromNode(container: HTMLElement, node: Node, offset: number): { charIndex: number; word?: string } | null {
  if (!container.contains(node)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(node, offset);
  const charIndex = Math.max(0, pre.toString().length);
  const text = container.textContent ?? "";
  const safeIndex = Math.max(0, Math.min(charIndex, text.length));
  const left = text.slice(0, safeIndex).match(/\S+$/)?.[0] ?? "";
  const right = text.slice(safeIndex).match(/^\S+/)?.[0] ?? "";
  const word = `${left}${right}`.trim();
  return { charIndex: safeIndex - left.length, word: word || undefined };
}

function caretTextOffsetWithin(container: HTMLElement, clientX: number, clientY: number): { charIndex: number; word?: string } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(clientX, clientY);
  if (position) return textOffsetFromNode(container, position.offsetNode, position.offset);
  const range = doc.caretRangeFromPoint?.(clientX, clientY);
  if (range) return textOffsetFromNode(container, range.startContainer, range.startOffset);
  return null;
}

function selectedTextOffsetWithin(container: HTMLElement, point?: { clientX: number; clientY: number }): { charIndex: number; word?: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return point ? caretTextOffsetWithin(container, point.clientX, point.clientY) : null;
  }
  const selected = sel.toString().trim();
  const range = sel.getRangeAt(0);
  if (!container.contains(range.startContainer)) {
    return point ? caretTextOffsetWithin(container, point.clientX, point.clientY) : null;
  }
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  const rawStart = pre.toString().length;
  const word = selected.split(/\s+/).filter(Boolean)[0] ?? "";
  if (word) {
    return {
      charIndex: Math.max(0, rawStart),
      word,
    };
  }
  return point ? caretTextOffsetWithin(container, point.clientX, point.clientY) : {
    charIndex: Math.max(0, rawStart),
    word: undefined,
  };
}

function highlightedTextNodes(text: string, range: { start: number; end: number } | null, highlightClassName: string): ReactNode {
  if (!range) return text;
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  return (
    <>
      {text.slice(0, start)}
      <mark className={highlightClassName}>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function scrollIntoViewIfOutside(container: HTMLElement | null, target: Element | null) {
  if (!container || !target) return;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (targetRect.top >= containerRect.top + 24 && targetRect.bottom <= containerRect.bottom - 24) return;
  target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
}

function preventEbookReaderScroll(ev: WheelEvent<HTMLElement>) {
  ev.preventDefault();
  ev.stopPropagation();
}

function dispatchEbookStartAt(ebookId: string, chunkIndex: number, charIndex: number, word?: string, source?: "navigation" | "word-dblclick") {
  window.dispatchEvent(
    new CustomEvent(EBOOK_START_EVENT, {
      detail: { ebookId, chunkIndex, pageIndex: chunkIndex, charIndex, word, source },
    })
  );
}

function dispatchLibraryAudioState(trackId: string, paused: boolean) {
  window.dispatchEvent(new CustomEvent(LIBRARY_AUDIO_STATE_EVENT, { detail: { trackId, paused } }));
}

function dispatchMediaPlaybackState(channelId: string, paused: boolean) {
  window.dispatchEvent(new CustomEvent(MEDIA_PLAYBACK_STATE_EVENT, { detail: { channelId, paused } }));
}

function ebookPartPreview(chunk: string): string {
  const trimmed = chunk.replace(/\s+/g, " ").trim();
  return trimmed.length > 88 ? `${trimmed.slice(0, 88)}…` : trimmed;
}

function ebookDisplayTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, " ").trim();
  return (
    cleaned
      .replace(/^\s*(?:\[|\(|\{)?\s*ebook\s*(?:\]|\)|\})?\s*(?:[:|/\\•·—–-]\s*)?/i, "")
      .trim() || cleaned
  );
}

function visiblePageIndices(pageCount: number, currentPage: number, radius = 6): number[] {
  const out = new Set<number>();
  const count = Math.max(0, pageCount);
  if (!count) return [];
  out.add(0);
  out.add(count - 1);
  for (let i = Math.max(0, currentPage - radius); i <= Math.min(count - 1, currentPage + radius); i++) {
    out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

function useEbookWheelPaging(currentPage: number, pageCount: number, goToPage: (idx: number) => void) {
  const wheelAccumRef = useRef(0);
  const lastTurnAtRef = useRef(0);
  return useCallback(
    (ev: WheelEvent<HTMLElement>) => {
      const rawDelta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
      if (!rawDelta) return;
      const el = ev.currentTarget;
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? Math.max(el.clientHeight, 1) : 1;
      const delta = rawDelta * unit;
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const canScrollCurrentPage =
        maxScrollTop > 2 &&
        ((delta > 0 && el.scrollTop < maxScrollTop - 2) || (delta < 0 && el.scrollTop > 2));
      if (canScrollCurrentPage) {
        wheelAccumRef.current = 0;
        return;
      }
      const direction = delta > 0 ? 1 : -1;
      const nextPage = currentPage + direction;
      if (nextPage < 0 || nextPage >= pageCount) return;
      ev.preventDefault();
      ev.stopPropagation();
      const now = performance.now();
      if (now - lastTurnAtRef.current > 600) wheelAccumRef.current = 0;
      wheelAccumRef.current += delta;
      if (Math.abs(wheelAccumRef.current) < 80 || now - lastTurnAtRef.current < 320) return;
      wheelAccumRef.current = 0;
      lastTurnAtRef.current = now;
      goToPage(nextPage);
    },
    [currentPage, goToPage, pageCount]
  );
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

function mpegTsIsFormatUnsupported(type: unknown, detail: unknown, extra: unknown): boolean {
  const text = `${String(type ?? "")} ${String(detail ?? "")} ${
    extra != null && typeof extra === "object" ? JSON.stringify(extra) : String(extra ?? "")
  }`.toLowerCase();
  return (
    text.includes("formatunsupported") ||
    text.includes("unsupported media type") ||
    text.includes("non mpeg-ts") ||
    text.includes("non-mpeg-ts") ||
    text.includes("non flv") ||
    text.includes("non-flv")
  );
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

  if (mpegTsIsFormatUnsupported(type, detail, extra)) {
    return (
      "This URL did not return MPEG-TS/FLV data. The provider may be returning MP4, HLS, an HTML login/error page, or another media type. " +
      "The player will try direct browser playback when possible; if it still fails, use a direct .m3u8 or .mp4 URL from your provider."
    );
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

function formatMediaDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function stripHtmlText(raw?: string): string {
  return String(raw ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function domainLabel(raw?: string): string {
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
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
  | "Podcast · native"
  | "Podcast · record tap"
  | "Library · native"
  | "Local video · native"
  | "Local video · preparing MKV…"
  | "Local video · MP4 (cache)"
  | "Local video · MP4 (remux)"
  | "Local video · MP4 (transcoded)"
  | "MKV · preparing…"
  | "MKV · HLS (cache)"
  | "MKV · HLS (remux)"
  | "MKV · HLS (transcoded)"
  | "MKV · HLS"
  | "MKV · MP4 (cache)"
  | "MKV · MP4 (remux)"
  | "MKV · MP4 (transcoded)"
  | "MKV · MP4"
  | "MKV · native (fallback)"
  | "MKV · native (direct)"
  | "VOD · blocked"
  | "URL · blocked";

function InternetAudioShowcase({
  channel,
  kind,
  playing,
  playbackMode,
  bufferLine,
  onTogglePlay,
}: {
  channel: Channel;
  kind: "radio" | "podcast";
  playing: boolean;
  playbackMode: PlaybackModeLabel | null;
  bufferLine: string | null;
  onTogglePlay: () => void;
}) {
  const isPodcast = kind === "podcast";
  const tags = (channel.radioTags ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  const description = stripHtmlText(channel.podcastDescription);
  const releaseDate = formatMediaDate(channel.podcastReleaseDate);
  const duration =
    typeof channel.podcastDurationMs === "number" && channel.podcastDurationMs > 0
      ? formatPlaybackClock(channel.podcastDurationMs / 1000)
      : "";
  const streamHost = domainLabel(channel.url);
  const homepageHost = domainLabel(channel.radioHomepage);
  const facts = isPodcast
    ? [
        channel.podcastShowName ? ["Show", channel.podcastShowName] : null,
        channel.podcastAuthor ? ["Host", channel.podcastAuthor] : null,
        channel.podcastGenre ? ["Genre", channel.podcastGenre] : null,
        releaseDate ? ["Released", releaseDate] : null,
        duration ? ["Length", duration] : null,
      ].filter((item): item is string[] => Array.isArray(item))
    : [
        channel.country ? ["Country", channel.country] : null,
        channel.radioCodec ? ["Codec", channel.radioCodec.toUpperCase()] : null,
        channel.radioBitrate ? ["Bitrate", `${channel.radioBitrate} kbps`] : null,
        homepageHost ? ["Homepage", homepageHost] : null,
        streamHost ? ["Stream host", streamHost] : null,
      ].filter((item): item is string[] => Array.isArray(item));

  return (
    <section className={`internet-audio-showcase internet-audio-showcase--${kind}`} aria-label={isPodcast ? "Podcast player" : "Radio player"}>
      <div className="internet-audio-bg" aria-hidden>
        {channel.logo ? <img src={channel.logo} alt="" /> : null}
      </div>
      <div className="internet-audio-card">
        <div className="internet-audio-art-shell">
          {channel.logo ? (
            <img className="internet-audio-art" src={channel.logo} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="internet-audio-art internet-audio-art--placeholder" aria-hidden>
              {isPodcast ? "🎙" : "♪"}
            </div>
          )}
          <div className={`internet-audio-status${!playing ? " internet-audio-status--paused" : ""}`}>
            <span className="internet-audio-status-dot" aria-hidden />
            {playing ? "Playing" : "Paused"}
          </div>
        </div>

        <div className="internet-audio-main">
          <div className="internet-audio-kicker">{isPodcast ? "Podcast episode" : "Live radio station"}</div>
          <h2 className="internet-audio-title">{channel.name}</h2>
          <p className="internet-audio-subtitle">
            {isPodcast
              ? [channel.podcastShowName, channel.podcastAuthor].filter(Boolean).join(" · ") || "Podcast"
              : [channel.country, channel.group].filter(Boolean).join(" · ") || "Internet radio"}
          </p>

          {isPodcast && description ? (
            <p className="internet-audio-description" title={description}>
              {description}
            </p>
          ) : null}

          {!isPodcast && tags.length ? (
            <div className="internet-audio-tags" aria-label="Station tags">
              {tags.map((tag) => (
                <span key={tag} className="internet-audio-tag">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {facts.length ? (
            <dl className="internet-audio-facts">
              {facts.map(([label, value]) => (
                <div key={label} className="internet-audio-fact">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {!isPodcast ? (
            <div className="internet-audio-actions">
              <button type="button" className="internet-audio-primary" onClick={onTogglePlay}>
                {playing ? "Pause" : "Play"}
              </button>
            </div>
          ) : null}

          <div className="internet-audio-technical">
            {playbackMode && isPodcast ? <span>{playbackMode}</span> : null}
            {!isPodcast && bufferLine ? <span>{bufferLine}</span> : null}
            {!isPodcast && streamHost ? <span>{streamHost}</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

type PdfJsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfJsPage>;
};

type PdfJsPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number; transform?: number[] };
  render: (options: { canvas?: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str?: unknown; transform?: unknown; width?: unknown; height?: unknown }> }>;
};

type PdfTextSpan = {
  text: string;
  start: number;
  end: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

const PdfTextLayer = memo(function PdfTextLayer({
  spans,
  pageIndex,
  ebookId,
}: {
  spans: PdfTextSpan[];
  pageIndex: number;
  ebookId: string;
}) {
  return (
    <>
      {spans.map((span, idx) => (
        <button
          key={`${pageIndex}-${idx}-${span.start}`}
          type="button"
          className="ebook-pdf-text-span"
          style={{
            left: span.left,
            top: span.top,
            width: span.width,
            height: span.height,
            fontSize: span.height * 0.78,
          }}
          title="Start reading from this text"
          onClick={() => {
            if (ebookId) dispatchEbookStartAt(ebookId, pageIndex, span.start, span.text);
          }}
          onDoubleClick={() => {
            if (ebookId) dispatchEbookStartAt(ebookId, pageIndex, span.start, span.text, "word-dblclick");
          }}
        >
          {span.text}
        </button>
      ))}
    </>
  );
});

function PdfHighlightOverlay({ spans, range }: { spans: PdfTextSpan[]; range: { start: number; end: number } | null }) {
  if (!range) return null;
  const highlighted: PdfTextSpan[] = [];
  for (const span of spans) {
    if (span.end <= range.start) continue;
    if (span.start >= range.end) break;
    highlighted.push(span);
  }
  return (
    <>
      {highlighted.map((span, idx) => (
          <span
            key={`${span.start}-${idx}`}
            className="ebook-pdf-highlight-box"
            aria-hidden
            style={{ left: span.left, top: span.top, width: span.width, height: span.height }}
          />
      ))}
    </>
  );
}

function normalizePdfPageText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function resolveEbookPdfBlob(channel: Channel): Promise<Blob> {
  if (channel.ebookBlob instanceof Blob && channel.ebookBlob.size > 0) return channel.ebookBlob;
  const id = channel.ebookId?.trim();
  if (!id) throw new Error("The original PDF file is not available.");
  const row = await getEbookLibraryItemById(id);
  if (!(row?.blob instanceof Blob) || row.blob.size <= 0) {
    throw new Error("The PDF file is missing from the library. Remove it and add the file again.");
  }
  return row.blob;
}

function cappedPdfRenderScale(page: PdfJsPage, requestedScale: number): number {
  const base = page.getViewport({ scale: 1 });
  const maxPixels = 3_200_000;
  const pixels = Math.max(1, base.width * requestedScale * base.height * requestedScale);
  if (pixels <= maxPixels) return requestedScale;
  return Math.max(0.55, Math.sqrt(maxPixels / Math.max(1, base.width * base.height)));
}

function dispatchEbookOcrText(ebookId: string, pageIndex: number, text: string) {
  window.dispatchEvent(new CustomEvent(EBOOK_OCR_TEXT_EVENT, { detail: { ebookId, pageIndex, text } }));
}

function EbookPlainTextPage({
  channel,
  ebookChunks,
  ebookStartChunk,
  ebookSpeechBoundary,
  ebookTtsActive,
  onEbookPageChange,
}: {
  channel: Channel;
  ebookChunks: string[];
  ebookStartChunk: number;
  ebookSpeechBoundary: EbookSpeechBoundary | null;
  ebookTtsActive: boolean;
  onEbookPageChange?: (pageIndex: number, pageCount: number, meta?: EbookPageChangeMeta) => void;
}) {
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const paragraphRef = useRef<HTMLParagraphElement | null>(null);
  const [textScale, setTextScale] = useState(1);
  const [visiblePart, setVisiblePart] = useState(ebookStartChunk);
  const speech = ebookSpeechBoundary;
  const currentPart = visiblePart;
  const pageCount = Math.max(ebookChunks.length, 1);
  useEffect(() => {
    setVisiblePart(Math.max(0, Math.min(ebookStartChunk, pageCount - 1)));
  }, [ebookStartChunk, pageCount]);
  useEffect(() => {
    if (!speech || speech.ebookId !== channel.ebookId) return;
    setVisiblePart(Math.max(0, Math.min(speech.chunkIndex, pageCount - 1)));
  }, [channel.ebookId, pageCount, speech]);
  const goToPart = useCallback(
    (idx: number) => {
      const next = Math.max(0, Math.min(pageCount - 1, idx));
      setVisiblePart(next);
      if (channel.ebookId) dispatchEbookStartAt(channel.ebookId, next, 0, undefined, "navigation");
    },
    [channel.ebookId, pageCount]
  );
  const onPageWheel = useEbookWheelPaging(currentPart, pageCount, goToPart);
  useEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [currentPart]);
  useEffect(() => {
    scrollIntoViewIfOutside(pageScrollRef.current, paragraphRef.current?.querySelector(".ebook-player-word") ?? null);
  }, [ebookSpeechBoundary]);
  const currentChunk = ebookChunks[currentPart] ?? "";
  const boundary =
    speech && speech.ebookId === channel.ebookId && speech.chunkIndex === currentPart
      ? speech
      : null;
  const range = ebookHighlightRange(currentChunk, boundary);
  const browserIndices = useMemo(() => visiblePageIndices(pageCount, currentPart), [currentPart, pageCount]);
  useEffect(() => {
    onEbookPageChange?.(currentPart, pageCount, { unit: "part" });
  }, [currentPart, onEbookPageChange, pageCount]);
  return (
    <div className="ebook-player-body">
      <nav className="ebook-page-browser" aria-label="Book parts">
        <div className="ebook-page-browser-title">Pages</div>
        <div className="ebook-page-browser-list">
          {browserIndices.map((idx) => {
            const chunk = ebookChunks[idx] ?? "";
            const isCurrent = idx === currentPart;
            return (
              <button
                key={idx}
                type="button"
                className={`ebook-page-browser-item${isCurrent ? " ebook-page-browser-item--current" : ""}`}
                onClick={() => goToPart(idx)}
              >
                <span className="ebook-page-browser-num">{idx + 1}</span>
                <span className="ebook-page-browser-preview">{ebookPartPreview(chunk)}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="ebook-reader-pane">
        <div className="ebook-real-toolbar ebook-real-toolbar--top">
          <button type="button" onClick={() => goToPart(0)} disabled={currentPart <= 0}>
            First Page
          </button>
          <button type="button" onClick={() => goToPart(currentPart - 1)} disabled={currentPart <= 0}>
            Previous
          </button>
          <span>Part {Math.min(currentPart + 1, pageCount)} of {pageCount}</span>
          <button type="button" onClick={() => goToPart(currentPart + 1)} disabled={currentPart >= pageCount - 1}>
            Next
          </button>
          <button type="button" onClick={() => goToPart(pageCount - 1)} disabled={currentPart >= pageCount - 1}>
            Last Page
          </button>
          <button type="button" onClick={() => setTextScale((s) => Math.max(0.8, Number((s - 0.1).toFixed(1))))}>
            A-
          </button>
          <span>{Math.round(textScale * 100)}%</span>
          <button type="button" onClick={() => setTextScale((s) => Math.min(1.8, Number((s + 0.1).toFixed(1))))}>
            A+
          </button>
        </div>
      <div
        ref={pageScrollRef}
        className={`ebook-player-text${ebookTtsActive ? " ebook-reader-scroll-locked" : ""}`}
        style={{ fontSize: `calc(clamp(1.08rem, 1.48vw, 1.42rem) * ${textScale})` }}
        onWheel={ebookTtsActive ? preventEbookReaderScroll : onPageWheel}
      >
            <section
              className="ebook-player-section ebook-player-section--start"
              aria-label={`Part ${currentPart + 1}`}
            >
              <span className="ebook-player-section-label">
                Current page
              </span>
              <p
                ref={paragraphRef}
                className="ebook-player-paragraph ebook-player-paragraph--selectable"
                onDoubleClick={(ev: ReactMouseEvent<HTMLParagraphElement>) => {
                  const ebookId = channel.ebookId;
                  if (!ebookId || !paragraphRef.current) return;
                  const hit = selectedTextOffsetWithin(paragraphRef.current, ev);
                  if (hit) dispatchEbookStartAt(ebookId, currentPart, hit.charIndex, hit.word, "word-dblclick");
                }}
              >
                {highlightedTextNodes(currentChunk, range, "ebook-player-word")}
              </p>
            </section>
      </div>
      </div>
    </div>
  );
}

function PdfReader({
  channel,
  pageTexts,
  ebookStartChunk,
  ebookSpeechBoundary,
  ebookTtsActive,
  onEbookPageChange,
}: {
  channel: Channel;
  pageTexts: string[];
  ebookStartChunk: number;
  ebookSpeechBoundary: EbookSpeechBoundary | null;
  ebookTtsActive: boolean;
  onEbookPageChange?: (pageIndex: number, pageCount: number, meta?: EbookPageChangeMeta) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfJsDocument | null>(null);
  const [pdfUtil, setPdfUtil] = useState<{ transform?: (m1: number[], m2: number[]) => number[] } | null>(null);
  const [pageIndex, setPageIndex] = useState(ebookStartChunk);
  const [scale, setScale] = useState(1.2);
  const [spans, setSpans] = useState<PdfTextSpan[]>([]);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState("Loading PDF…");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrPageTexts, setOcrPageTexts] = useState<Record<number, string>>({});
  const effectivePageTexts = useMemo(
    () => Array.from({ length: Math.max(pdfDoc?.numPages ?? 0, pageTexts.length, 1) }, (_, idx) => ocrPageTexts[idx] ?? pageTexts[idx] ?? ""),
    [ocrPageTexts, pageTexts, pdfDoc?.numPages]
  );
  const effectivePageTextsRef = useRef(effectivePageTexts);
  useEffect(() => {
    effectivePageTextsRef.current = effectivePageTexts;
  }, [effectivePageTexts]);
  const pageCount = pdfDoc?.numPages ?? Math.max(effectivePageTexts.length, 1);
  const ebookId = channel.ebookId ?? "";

  useEffect(() => {
    setPageIndex(Math.max(0, Math.min(ebookStartChunk, pageCount - 1)));
  }, [ebookStartChunk, pageCount]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { promise: Promise<unknown>; destroy?: () => void } | null = null;
    setStatus("Loading PDF…");
    setPdfDoc(null);
    setSpans([]);
    setPageSize({ width: 0, height: 0 });
    void (async () => {
      try {
        const blob = await resolveEbookPdfBlob(channel);
        const pdfjs = await loadPdfJs();
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({
          data,
          isEvalSupported: false,
        } as Parameters<typeof pdfjs.getDocument>[0]) as { promise: Promise<unknown>; destroy?: () => void };
        const doc = (await loadingTask.promise) as PdfJsDocument;
        if (cancelled) return;
        setPdfUtil(pdfjs.Util ?? null);
        setPdfDoc(doc);
        setPageIndex((cur) => Math.max(0, Math.min(cur, doc.numPages - 1)));
        setStatus(doc.numPages > 0 ? "" : "This PDF has no pages.");
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      try {
        loadingTask?.destroy?.();
      } catch {
        /* noop */
      }
      setPdfDoc(null);
      setPdfUtil(null);
    };
  }, [channel.ebookBlob, channel.ebookId]);

  useEffect(() => {
    let cancelled = false;
    setSpans([]);
    void (async () => {
      try {
        if (!pdfDoc || !canvasRef.current) return;
        setStatus("Rendering page…");
        const page = await pdfDoc.getPage(pageIndex + 1);
        if (cancelled) return;
        const renderScale = cappedPdfRenderScale(page, scale);
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not create a PDF canvas context.");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        setPageSize((prev) =>
          Math.abs(prev.width - viewport.width) < 0.5 && Math.abs(prev.height - viewport.height) < 0.5
            ? prev
            : { width: viewport.width, height: viewport.height }
        );
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled) return;
        const text = await page.getTextContent();
        if (cancelled) return;
        let cursor = 0;
        const pageTextParts: string[] = [];
        const nextSpans: PdfTextSpan[] = [];
        for (const item of text.items) {
          const str = typeof item.str === "string" ? item.str : "";
          if (!str.trim()) {
            cursor += str.length + 1;
            continue;
          }
          const rawTransform = Array.isArray(item.transform) ? (item.transform as number[]) : null;
          const tx = rawTransform && viewport.transform && pdfUtil?.transform
            ? pdfUtil.transform(viewport.transform, rawTransform)
            : rawTransform;
          const fontHeight = tx ? Math.max(8, Math.hypot(tx[2] ?? 0, tx[3] ?? 10)) : 12;
          const left = tx?.[4] ?? 0;
          const top = tx ? viewport.height - (tx[5] ?? 0) - fontHeight : 0;
          const width = typeof item.width === "number" ? Math.max(8, item.width * renderScale) : Math.max(8, str.length * fontHeight * 0.45);
          pageTextParts.push(str);
          nextSpans.push({
            text: str,
            start: cursor,
            end: cursor + str.length,
            left,
            top,
            width,
            height: fontHeight * 1.25,
          });
          cursor += str.length + 1;
        }
        setSpans(nextSpans);
        const extractedPageText = normalizePdfPageText(pageTextParts.join(" "));
        const knownPageText = (effectivePageTextsRef.current[pageIndex] ?? "").trim();
        if (extractedPageText && ebookId && !knownPageText) {
          setOcrPageTexts((prev) => (prev[pageIndex] ? prev : { ...prev, [pageIndex]: extractedPageText }));
          dispatchEbookOcrText(ebookId, pageIndex, extractedPageText);
        }
        if (nextSpans.length === 0 && !knownPageText) {
          setStatus("This PDF page has no selectable text. Press OCR page to scan it for read-aloud and highlighting.");
        } else {
          setStatus(renderScale < scale ? "Large page rendered at a lighter resolution to avoid high memory use." : "");
        }
      } catch (e) {
        if (!cancelled) {
          setPageSize({ width: 0, height: 0 });
          setStatus(e instanceof Error ? `Could not render this PDF page: ${e.message}` : `Could not render this PDF page: ${String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ebookId, pageIndex, pdfDoc, pdfUtil, scale]);

  useEffect(() => {
    const speech = ebookSpeechBoundary;
    if (!speech || speech.ebookId !== ebookId) return;
    setPageIndex(Math.max(0, Math.min(speech.chunkIndex, Math.max(pageCount - 1, 0))));
  }, [ebookId, ebookSpeechBoundary, pageCount]);

  const runOcr = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ebookId) return;
    setOcrBusy(true);
    setStatus("Running OCR on this page…");
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng");
      const result = await worker.recognize(canvas.toDataURL("image/png"));
      await worker.terminate();
      const text = String(result.data.text ?? "").trim();
      if (!text) throw new Error("OCR did not find readable text on this page.");
      setOcrPageTexts((prev) => ({ ...prev, [pageIndex]: text }));
      dispatchEbookOcrText(ebookId, pageIndex, text);
      setStatus("OCR text saved for this page.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setOcrBusy(false);
    }
  }, [ebookId, pageIndex]);

  const boundary =
    ebookSpeechBoundary && ebookSpeechBoundary.ebookId === ebookId && ebookSpeechBoundary.chunkIndex === pageIndex
      ? ebookSpeechBoundary
      : null;
  const range = ebookHighlightRange(effectivePageTexts[pageIndex] ?? "", boundary);
  const goToPdfPage = useCallback(
    (idx: number) => {
      const next = Math.max(0, Math.min(pageCount - 1, idx));
      setPageIndex(next);
      if (ebookId) dispatchEbookStartAt(ebookId, next, 0, undefined, "navigation");
    },
    [ebookId, pageCount]
  );
  const onPageWheel = useEbookWheelPaging(pageIndex, pageCount, goToPdfPage);
  useEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pageIndex]);
  const browserIndices = useMemo(() => visiblePageIndices(pageCount, pageIndex), [pageCount, pageIndex]);
  useEffect(() => {
    onEbookPageChange?.(pageIndex, pageCount, { unit: "page" });
  }, [onEbookPageChange, pageCount, pageIndex]);

  return (
    <div className="ebook-real-reader">
      <aside className="ebook-real-sidebar" aria-label="PDF pages">
        <div className="ebook-page-browser-title">Pages</div>
        <div className="ebook-real-thumb-list">
          {browserIndices.map((idx) => (
            <button
              key={idx}
              type="button"
              className={`ebook-real-thumb${idx === pageIndex ? " ebook-real-thumb--current" : ""}`}
              onClick={() => goToPdfPage(idx)}
            >
              <span className="ebook-real-thumb-page">{idx + 1}</span>
              <span className="ebook-real-thumb-lines">{ebookPartPreview(effectivePageTexts[idx] || "Scanned page")}</span>
            </button>
          ))}
        </div>
      </aside>
      <section className="ebook-real-main">
        <div className="ebook-real-toolbar ebook-real-toolbar--top">
          <button type="button" onClick={() => goToPdfPage(0)} disabled={pageIndex <= 0}>
            First Page
          </button>
          <button type="button" onClick={() => goToPdfPage(pageIndex - 1)} disabled={pageIndex <= 0}>
            Previous
          </button>
          <span>Page {pageIndex + 1} of {pageCount}</span>
          <button type="button" onClick={() => goToPdfPage(pageIndex + 1)} disabled={pageIndex >= pageCount - 1}>
            Next
          </button>
          <button type="button" onClick={() => goToPdfPage(pageCount - 1)} disabled={pageIndex >= pageCount - 1}>
            Last Page
          </button>
          <button type="button" onClick={() => setScale((s) => Math.max(0.7, Number((s - 0.1).toFixed(1))))}>A-</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((s) => Math.min(2.4, Number((s + 0.1).toFixed(1))))}>A+</button>
          <button type="button" onClick={() => void runOcr()} disabled={ocrBusy || !pdfDoc}>
            {ocrBusy ? "OCR…" : "OCR page"}
          </button>
        </div>
        {status ? <div className="ebook-real-status" role="status">{status}</div> : null}
        <div
          ref={pageScrollRef}
          className={`ebook-pdf-scroll${ebookTtsActive ? " ebook-reader-scroll-locked" : ""}`}
          onWheel={ebookTtsActive ? preventEbookReaderScroll : onPageWheel}
        >
          {!pdfDoc && !status ? (
            <div className="ebook-pdf-loading" role="status">
              Loading PDF…
            </div>
          ) : null}
          <div className="ebook-pdf-page" style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}>
            <canvas ref={canvasRef} className="ebook-pdf-canvas" />
            <div className="ebook-pdf-text-layer" aria-label={`PDF page ${pageIndex + 1}`}>
              <PdfHighlightOverlay spans={spans} range={range} />
              <PdfTextLayer spans={spans} pageIndex={pageIndex} ebookId={ebookId} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function extractEpubMediaHtml(html: string): string {
  return sanitizeEpubMediaHtml(html);
}

function epubDocTitleFromHtml(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html || "<p></p>", "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  const heading =
    doc.body.querySelector("h1, h2, h3, [role='heading'], title")?.textContent ??
    doc.querySelector("title")?.textContent ??
    "";
  return heading.replace(/\s+/g, " ").trim();
}

function EpubReader({
  channel,
  pageTexts,
  ebookStartChunk,
  ebookSpeechBoundary,
  ebookTtsActive,
  onEbookPageChange,
}: {
  channel: Channel;
  pageTexts: string[];
  ebookStartChunk: number;
  ebookSpeechBoundary: EbookSpeechBoundary | null;
  ebookTtsActive: boolean;
  onEbookPageChange?: (pageIndex: number, pageCount: number, meta?: EbookPageChangeMeta) => void;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const paragraphRef = useRef<HTMLParagraphElement | null>(null);
  const [pageIndex, setPageIndex] = useState(ebookStartChunk);
  const [scale, setScale] = useState(1);
  const [pages, setPages] = useState<Array<{ html: string; text: string; title?: string }>>([]);
  const [status, setStatus] = useState("Loading EPUB…");
  const ebookId = channel.ebookId ?? "";

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];
    setStatus("Loading EPUB…");
    setPages([]);
    void (async () => {
      try {
        if (!(channel.ebookBlob instanceof Blob)) throw new Error("The original EPUB file is not available.");
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(channel.ebookBlob);
        const container = await zip.file("META-INF/container.xml")?.async("string");
        const rootfile = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!rootfile) throw new Error("Could not find the EPUB package file.");
        const opf = await zip.file(rootfile)?.async("string");
        if (!opf) throw new Error("Could not read the EPUB package file.");
        const packageBase = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
        const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
        const spineTag = opf.match(/<spine\b[^>]*>/i)?.[0] ?? "";
        const ncxId = spineTag.match(/\btoc\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
        for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
          const tag = item[0];
          const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
          const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
          const mediaType = tag.match(/\bmedia-type\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
          const properties = tag.match(/\bproperties\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
          if (id && href) manifest.set(id, { href, mediaType, properties });
        }
        const resolve = (baseDir: string, href: string) => {
          const cleanHref = href.split("#")[0]?.split("?")[0] ?? "";
          let decodedHref = cleanHref;
          try {
            decodedHref = decodeURIComponent(cleanHref);
          } catch {
            decodedHref = cleanHref;
          }
          const parts = `${baseDir}${decodedHref}`.split("/");
          const out: string[] = [];
          for (const part of parts) {
            if (!part || part === ".") continue;
            if (part === "..") out.pop();
            else out.push(part);
          }
          return out.join("/");
        };
        const tocTitles = new Map<string, string>();
        const addTocTitle = (baseDir: string, href: string, title: string) => {
          const cleanTitle = title.replace(/\s+/g, " ").trim();
          if (!cleanTitle) return;
          const path = resolve(baseDir, href);
          if (!tocTitles.has(path)) tocTitles.set(path, cleanTitle);
        };
        const navEntry = Array.from(manifest.values()).find((entry) =>
          /\bnav\b/i.test(entry.properties) && /\.(xhtml|html|htm|xml)$/i.test(entry.href)
        );
        if (navEntry) {
          const navPath = resolve(packageBase, navEntry.href);
          const navHtml = await zip.file(navPath)?.async("string");
          if (navHtml && typeof DOMParser !== "undefined") {
            const navBase = navPath.includes("/") ? navPath.slice(0, navPath.lastIndexOf("/") + 1) : "";
            const navDoc = new DOMParser().parseFromString(navHtml, "text/html");
            const tocNav =
              Array.from(navDoc.querySelectorAll("nav")).find((nav) =>
                /toc/i.test(`${nav.getAttribute("epub:type") ?? ""} ${nav.getAttribute("type") ?? ""} ${nav.getAttribute("role") ?? ""}`)
              ) ?? navDoc.querySelector("nav");
            tocNav?.querySelectorAll("a[href]").forEach((a) => {
              addTocTitle(navBase, a.getAttribute("href") ?? "", a.textContent ?? "");
            });
          }
        }
        const ncxEntry = (ncxId ? manifest.get(ncxId) : null) ??
          Array.from(manifest.values()).find((entry) => /dtbncx|ncx/i.test(entry.mediaType) || /\.ncx$/i.test(entry.href));
        if (ncxEntry) {
          const ncxPath = resolve(packageBase, ncxEntry.href);
          const ncxXml = await zip.file(ncxPath)?.async("string");
          if (ncxXml && typeof DOMParser !== "undefined") {
            const ncxBase = ncxPath.includes("/") ? ncxPath.slice(0, ncxPath.lastIndexOf("/") + 1) : "";
            const ncxDoc = new DOMParser().parseFromString(ncxXml, "application/xml");
            Array.from(ncxDoc.querySelectorAll("navPoint")).forEach((point) => {
              const src = point.querySelector("content")?.getAttribute("src") ?? "";
              const title = point.querySelector("navLabel text")?.textContent ?? "";
              addTocTitle(ncxBase, src, title);
            });
          }
        }
        const assetUrls = new Map<string, string>();
        for (const entry of manifest.values()) {
          if (!/^image\//i.test(entry.mediaType) && !/font|css/i.test(entry.mediaType)) continue;
          const path = resolve(packageBase, entry.href);
          const file = zip.file(path);
          if (!file) continue;
          const blob = await file.async("blob");
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          assetUrls.set(path, url);
        }
        const built: Array<{ html: string; text: string; title?: string }> = [];
        for (const ref of opf.matchAll(/<itemref\b[^>]*>/gi)) {
          const idref = ref[0].match(/\bidref\s*=\s*["']([^"']+)["']/i)?.[1];
          const entry = idref ? manifest.get(idref) : null;
          if (!entry || !/\.(xhtml|html|htm|xml)$/i.test(entry.href)) continue;
          const path = resolve(packageBase, entry.href);
          let html = await zip.file(path)?.async("string");
          if (!html) continue;
          html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s(on\w+)=["'][^"']*["']/gi, "");
          const chapterBase = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
          const assetUrlForHref = (href: string) => {
            if (/^(https?:|data:|blob:|#)/i.test(href)) return null;
            const chapterPath = resolve(chapterBase, href);
            return assetUrls.get(chapterPath) ?? assetUrls.get(resolve(packageBase, href)) ?? null;
          };
          html = html.replace(/\b(src|href)=["']([^"']+)["']/gi, (raw, attr: string, href: string) => {
            const url = assetUrlForHref(href);
            return url ? `${attr}="${url}"` : raw;
          });
          html = html.replace(/\bsrcset=["']([^"']+)["']/gi, (raw, srcset: string) => {
            const mapped = srcset
              .split(",")
              .map((part) => {
                const [href, descriptor] = part.trim().split(/\s+/, 2);
                if (!href) return "";
                const url = assetUrlForHref(href);
                return url ? [url, descriptor].filter(Boolean).join(" ") : part.trim();
              })
              .filter(Boolean)
              .join(", ");
            return mapped ? `srcset="${mapped}"` : raw;
          });
          const text = new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/g, " ").trim() ?? "";
          if (!text) continue;
          built.push({ html, text, title: tocTitles.get(path) ?? epubDocTitleFromHtml(html) });
        }
        if (cancelled) return;
        setPages(built.length ? built : pageTexts.map((text) => ({ html: `<p>${text}</p>`, text })));
        setStatus("");
      } catch (e) {
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [channel.ebookBlob, pageTexts]);

  useEffect(() => {
    setPageIndex(Math.max(0, Math.min(ebookStartChunk, Math.max(pages.length - 1, 0))));
  }, [ebookStartChunk, pages.length]);

  useEffect(() => {
    const speech = ebookSpeechBoundary;
    if (!speech || speech.ebookId !== ebookId) return;
    setPageIndex(Math.max(0, Math.min(speech.chunkIndex, Math.max(pages.length - 1, 0))));
  }, [ebookId, ebookSpeechBoundary, pages.length]);

  const current = pages[pageIndex] ?? null;
  const syncText = pageTexts[pageIndex] || current?.text || "";
  const boundary =
    ebookSpeechBoundary && ebookSpeechBoundary.ebookId === ebookId && ebookSpeechBoundary.chunkIndex === pageIndex
      ? ebookSpeechBoundary
      : null;
  const range = ebookHighlightRange(syncText, boundary);
  const pageCount = Math.max(pages.length || pageTexts.length, 1);
  const goToEpubPage = useCallback(
    (idx: number) => {
      const next = Math.max(0, Math.min(pageCount - 1, idx));
      setPageIndex(next);
      if (ebookId) dispatchEbookStartAt(ebookId, next, 0, undefined, "navigation");
    },
    [ebookId, pageCount]
  );
  const onPageWheel = useEbookWheelPaging(pageIndex, pageCount, goToEpubPage);
  useEffect(() => {
    articleRef.current?.scrollTo({ top: 0, left: 0 });
  }, [pageIndex]);
  const mediaHtml = useMemo(() => extractEpubMediaHtml(current?.html ?? ""), [current?.html]);
  useEffect(() => {
    scrollIntoViewIfOutside(articleRef.current, articleRef.current?.querySelector(".ebook-epub-word--highlight") ?? null);
  }, [range]);
  const browserPages: Array<{ html: string; text: string; title?: string }> = pages.length
    ? pages
    : pageTexts.map((text) => ({ html: "", text }));
  const browserIndices = useMemo(() => visiblePageIndices(pageCount, pageIndex), [pageCount, pageIndex]);
  const chapterLabel = current?.title?.trim() || `Chapter ${pageIndex + 1}`;
  useEffect(() => {
    onEbookPageChange?.(pageIndex, pageCount, { unit: "chapter", label: chapterLabel });
  }, [chapterLabel, onEbookPageChange, pageCount, pageIndex]);
  return (
    <div className="ebook-real-reader">
      <aside className="ebook-real-sidebar" aria-label="EPUB chapters">
        <div className="ebook-page-browser-title">Contents</div>
        <div className="ebook-real-thumb-list">
          {browserIndices.map((idx) => {
            const page = browserPages[idx] ?? { html: "", text: "" };
            return (
            <button
              key={idx}
              type="button"
              className={`ebook-real-thumb${idx === pageIndex ? " ebook-real-thumb--current" : ""}`}
              onClick={() => goToEpubPage(idx)}
            >
              <span className="ebook-real-thumb-page">{page.title?.trim() || `Chapter ${idx + 1}`}</span>
              <span className="ebook-real-thumb-lines">{ebookPartPreview(page.text || page.title || `Chapter ${idx + 1}`)}</span>
            </button>
            );
          })}
        </div>
      </aside>
      <section className="ebook-real-main">
        <div className="ebook-real-toolbar ebook-real-toolbar--top">
          <button type="button" onClick={() => goToEpubPage(0)} disabled={pageIndex <= 0}>First Chapter</button>
          <button type="button" onClick={() => goToEpubPage(pageIndex - 1)} disabled={pageIndex <= 0}>Previous</button>
          <span>Chapter {pageIndex + 1} of {pageCount}</span>
          <button type="button" onClick={() => goToEpubPage(pageIndex + 1)} disabled={pageIndex >= pageCount - 1}>Next</button>
          <button type="button" onClick={() => goToEpubPage(pageCount - 1)} disabled={pageIndex >= pageCount - 1}>Last Chapter</button>
          <button type="button" onClick={() => setScale((s) => Math.max(0.8, Number((s - 0.1).toFixed(1))))}>A-</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((s) => Math.min(1.8, Number((s + 0.1).toFixed(1))))}>A+</button>
        </div>
        {status ? <div className="ebook-real-status" role="status">{status}</div> : null}
        <article
          ref={articleRef}
          className={`ebook-epub-page${ebookTtsActive ? " ebook-reader-scroll-locked" : ""}`}
          style={{ fontSize: `calc(clamp(1rem, 1.3vw, 1.28rem) * ${scale})` }}
          onWheel={ebookTtsActive ? preventEbookReaderScroll : onPageWheel}
        >
          {mediaHtml ? (
            <div className="ebook-epub-media" dangerouslySetInnerHTML={{ __html: mediaHtml }} />
          ) : null}
          <p
            ref={paragraphRef}
            className="ebook-epub-sync-text ebook-epub-sync-text--selectable"
            onDoubleClick={(ev: ReactMouseEvent<HTMLParagraphElement>) => {
              if (!ebookId || !paragraphRef.current) return;
              const hit = selectedTextOffsetWithin(paragraphRef.current, ev);
              if (hit) dispatchEbookStartAt(ebookId, pageIndex, hit.charIndex, hit.word, "word-dblclick");
            }}
          >
            {syncText ? highlightedTextNodes(syncText, range, "ebook-epub-word--highlight") : "No readable EPUB page found."}
          </p>
        </article>
      </section>
    </div>
  );
}

export function VideoPlayer({
  channel,
  volume = 1,
  onVolumeChange,
  paneLabel,
  recordable = true,
  streamProxyOrigin,
  splitIsolateNetwork = false,
  playbackPane,
  inSplitView = false,
  onLocalLibraryAudioEnded,
  onRecordingStatusChange,
  layoutMode = "default",
}: VideoPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  /** Latest `channel` from props — stream effect cleanup compares against this for library restarts. */
  const latestChannelRef = useRef<Channel | null>(null);
  latestChannelRef.current = channel;
  const onLocalLibraryAudioEndedRef = useRef(onLocalLibraryAudioEnded);
  onLocalLibraryAudioEndedRef.current = onLocalLibraryAudioEnded;
  const playbackPaneRef = useRef(playbackPane);
  playbackPaneRef.current = playbackPane;
  const onRecordingStatusChangeRef = useRef(onRecordingStatusChange);
  onRecordingStatusChangeRef.current = onRecordingStatusChange;
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const externalUrlRef = useRef<string | null>(null);
  const recordIdRef = useRef<string | null>(null);
  /** Same bytes as disk recording; only set in desktop after REC (single upstream). */
  const [recordTapPlayUrl, setRecordTapPlayUrl] = useState<string | null>(null);
  const prevStreamUrlForResetRef = useRef<string | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordErr, setRecordErr] = useState<string | null>(null);
  const [recordSavedPath, setRecordSavedPath] = useState<string | null>(null);
  const [recordingSourceUrl, setRecordingSourceUrl] = useState<string | null>(null);
  const [screenPlaybackOff, setScreenPlaybackOff] = useState(false);
  const [playbackMode, setPlaybackMode] = useState<PlaybackModeLabel | null>(null);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string>("off");
  const [ccEnabled, setCcEnabled] = useState(true);
  const [bufferLine, setBufferLine] = useState("—");
  const [underLogoFailed, setUnderLogoFailed] = useState(false);
  /** Radio has no native `<video controls>`; keep UI in sync for the overlay play/pause button. */
  const [radioPlaying, setRadioPlaying] = useState(false);
  /** True while the EQ panel has routed audio through Web Audio (radio / podcast / library). */
  const [eqActive, setEqActive] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytErr, setYtErr] = useState<string | null>(null);

  type Mp3LyricsState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; data: LocalMp3LyricsResult };
  const [mp3Lyrics, setMp3Lyrics] = useState<Mp3LyricsState>({ kind: "idle" });
  const [mp3LyricsHidden, setMp3LyricsHidden] = useState(false);
  /** Artist / title / album from file tags (shown above lyrics). */
  const [lyricsTrackMeta, setLyricsTrackMeta] = useState<TrackFileMetadata | null>(null);
  const [lyricsCoverUrl, setLyricsCoverUrl] = useState<string | null>(null);
  /** LLM “what this song is about” — separate from lyrics fetch so duration updates do not abort it. */
  const [songMeaningLoading, setSongMeaningLoading] = useState(false);
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
  const apiOnlyLyricsPreviewRef = useRef(false);
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
  const volumePopoverRef = useRef<HTMLDivElement>(null);
  const volumeTriggerRef = useRef<HTMLButtonElement>(null);
  const volumeAnchoredPanelRef = useRef<HTMLDivElement>(null);
  const [volumePopoverOpen, setVolumePopoverOpen] = useState(false);
  const [playerChromeNotice, setPlayerChromeNotice] = useState<string | null>(null);
  const [ebookSpeechBoundary, setEbookSpeechBoundary] = useState<EbookSpeechBoundary | null>(null);
  const [ebookTtsActive, setEbookTtsActive] = useState(false);
  const ebookPlayerRef = useRef<HTMLElement | null>(null);
  const [ebookFullscreen, setEbookFullscreen] = useState(false);
  const radioCaptionsCtrlRef = useRef<RadioLiveCaptionsController | null>(null);
  const radioCaptionTranslateAbortRef = useRef<AbortController | null>(null);
  const radioCaptionTranslateTargetRef = useRef<string | null>(null);
  const [radioCaptionsEnabled, setRadioCaptionsEnabled] = useState(false);
  const [radioCaptionSegments, setRadioCaptionSegments] = useState<RadioCaptionSegment[]>([]);
  const [radioCaptionsStatus, setRadioCaptionsStatus] = useState("");
  const [radioCaptionsErr, setRadioCaptionsErr] = useState<string | null>(null);
  const [radioCaptionTranslateTarget, setRadioCaptionTranslateTarget] = useState<string | null>(null);
  const [radioCaptionTranslateBusy, setRadioCaptionTranslateBusy] = useState(false);
  const [radioCaptionTranslateErr, setRadioCaptionTranslateErr] = useState<string | null>(null);
  const [radioCaptionTranslateHint, setRadioCaptionTranslateHint] = useState<string | null>(null);

  const hasDesktopRecordApi =
    typeof window !== "undefined" &&
    !!window.iptv?.pickRecordDir &&
    !!window.iptv?.startStreamRecord &&
    !!window.iptv?.stopStreamRecord;

  const isRadioChannel = !!channel?.id && isRadioStationChannelId(channel.id);
  const isPodcastChannel = !!channel?.id && isPodcastChannelId(channel.id);
  const isInternetAudioStream = isRadioChannel || isPodcastChannel;
  const isYoutubeChannel = !!channel?.youtubeVideoId?.trim();
  const isWebVideoPageChannel = !!channel?.webVideoPageUrl?.trim();
  const isEmbeddedWebChannel = isYoutubeChannel || isWebVideoPageChannel;
  const isEbookChannel = !!channel?.ebookId?.trim() && (!!channel.ebookText?.trim() || channel.ebookBlob instanceof Blob);
  const streamOkForRecord =
    !!channel?.url?.trim() && !isWebVideoPageChannel && canRecordRawHttpStream(channel.url, channel.id);
  const ebookChunks = useMemo(() => {
    const pages = channel?.ebookPages?.map((page) => page.trim()).filter(Boolean);
    if (pages?.length) return pages;
    return splitEbookText(channel?.ebookText ?? "");
  }, [channel?.ebookPages, channel?.ebookText]);
  const ebookStartChunk =
    typeof channel?.ebookStartChunk === "number" && Number.isFinite(channel.ebookStartChunk)
      ? Math.max(0, Math.min(channel.ebookStartChunk, Math.max(ebookChunks.length - 1, 0)))
      : 0;
  const [ebookPageNav, setEbookPageNav] = useState<EbookPageNav>(() => ({
    current: ebookStartChunk + 1,
    total: Math.max(ebookChunks.length, 1),
    unit: ebookPageNavUnitFromFormat(channel?.ebookFormat),
  }));
  const handleEbookPageChange = useCallback((pageIndex: number, pageCount: number, meta?: EbookPageChangeMeta) => {
    const total = Math.max(1, pageCount);
    const current = Math.max(1, Math.min(pageIndex + 1, total));
    setEbookPageNav((prev) => {
      const unit = meta?.unit ?? prev.unit;
      const label = meta?.label?.trim() || undefined;
      if (prev.current === current && prev.total === total && prev.unit === unit && prev.label === label) return prev;
      return { current, total, unit, label };
    });
  }, []);
  useEffect(() => {
    if (!channel?.ebookId) return;
    setEbookPageNav({
      current: Math.min(ebookStartChunk + 1, Math.max(ebookChunks.length, 1)),
      total: Math.max(ebookChunks.length, 1),
      unit: ebookPageNavUnitFromFormat(channel.ebookFormat),
      label: undefined,
    });
  }, [channel?.ebookId]);
  useEffect(() => {
    if (!isEbookChannel || !channel?.ebookId) {
      setEbookSpeechBoundary(null);
      setEbookTtsActive(false);
      return;
    }
    const onBoundary = (ev: Event) => {
      const detail = (ev as CustomEvent<EbookSpeechBoundary>).detail;
      if (!detail || detail.ebookId !== channel.ebookId) return;
      startTransition(() => {
        setEbookSpeechBoundary((prev) => {
          if (
            prev?.ebookId === detail.ebookId &&
            prev.chunkIndex === detail.chunkIndex &&
            prev.charIndex === detail.charIndex &&
            prev.charLength === detail.charLength
          ) {
            return prev;
          }
          return detail;
        });
      });
    };
    window.addEventListener(EBOOK_SPEECH_EVENT, onBoundary);
    return () => window.removeEventListener(EBOOK_SPEECH_EVENT, onBoundary);
  }, [channel?.ebookId, isEbookChannel]);

  useEffect(() => {
    if (!isEbookChannel || !channel?.ebookId) {
      setEbookTtsActive(false);
      return;
    }
    setEbookTtsActive(false);
    const onTtsActive = (ev: Event) => {
      const detail = (ev as CustomEvent<EbookTtsActiveDetail>).detail;
      if (!detail || detail.ebookId !== channel.ebookId) return;
      setEbookTtsActive(Boolean(detail.active));
    };
    window.addEventListener(EBOOK_TTS_ACTIVE_EVENT, onTtsActive);
    return () => window.removeEventListener(EBOOK_TTS_ACTIVE_EVENT, onTtsActive);
  }, [channel?.ebookId, isEbookChannel]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setEbookFullscreen(document.fullscreenElement === ebookPlayerRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleEbookFullscreen = useCallback(() => {
    const node = ebookPlayerRef.current;
    if (!node) return;
    if (document.fullscreenElement === node) {
      void document.exitFullscreen?.();
      return;
    }
    void node.requestFullscreen?.();
  }, []);
  const isLibraryChannel =
    !!channel?.libraryTrackId?.trim() &&
    !!channel.url?.trim() &&
    channel.url.trim().toLowerCase().startsWith("blob:");
  const isLocalVideoChannel =
    !!channel?.localVideoFile &&
    !!channel.url?.trim() &&
    (/^file:/i.test(channel.url.trim()) || /^blob:/i.test(channel.url.trim()));
  /** Timeline + scale in white player chrome (not native video controls). */
  const useChromeSeek =
    isLibraryChannel ||
    isPodcastChannel ||
    isLocalVideoChannel ||
    (!!channel && !isEbookChannel && !isEmbeddedWebChannel && !isRadioChannel);
  const webVideoEmbedSrc =
    isYoutubeChannel && channel?.youtubeVideoId
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(channel.youtubeVideoId)}?autoplay=1&rel=0`
      : isWebVideoPageChannel && channel?.webVideoPageUrl
        ? channel.webVideoPageUrl
      : null;

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

  useEffect(() => {
    setUnderLogoFailed(false);
  }, [channel?.id, channel?.logo]);

  const mediaEqEnabled = (isInternetAudioStream && !isPodcastChannel) || isLibraryChannel;
  const eqPageScope = eqPageScopeForChannel(channel) ?? "radio";

  useEffect(() => {
    if (!mediaEqEnabled) setEqActive(false);
  }, [mediaEqEnabled]);

  useEffect(() => {
    setYtErr(null);
    setYtBusy(false);
    setMp3Lyrics({ kind: "idle" });
    setMp3LyricsHidden(false);
    apiOnlyLyricsPreviewRef.current = false;
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
    setVolumePopoverOpen(false);
    setLyricsSpatialBox(null);
    radioCaptionsCtrlRef.current?.stop();
    radioCaptionsCtrlRef.current = null;
    radioCaptionTranslateAbortRef.current?.abort();
    radioCaptionTranslateAbortRef.current = null;
    setRadioCaptionsEnabled(false);
    setRadioCaptionSegments([]);
    setRadioCaptionsStatus("");
    setRadioCaptionsErr(null);
    setRadioCaptionTranslateTarget(null);
    radioCaptionTranslateTargetRef.current = null;
    setRadioCaptionTranslateBusy(false);
    setRadioCaptionTranslateErr(null);
    setRadioCaptionTranslateHint(null);
  }, [channel?.id]);

  useEffect(() => {
    radioCaptionTranslateTargetRef.current = radioCaptionTranslateTarget;
  }, [radioCaptionTranslateTarget]);

  useEffect(() => {
    if (!isEbookChannel) return;
    setMp3Lyrics({ kind: "idle" });
    setMp3LyricsHidden(true);
    setLyricsSpatialBox(null);
    lyricsTranslateAbortRef.current?.abort();
    lyricsTranslateAbortRef.current = null;
    setLyricsOverridePairs(null);
    setLyricsTranslateTarget(null);
    setLyricsTranslateBusy(false);
    setLyricsTranslateErr(null);
    setLyricsTranslateHint(null);
  }, [isEbookChannel]);

  useEffect(() => {
    if (!channel || !useChromeSeek) {
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
  }, [channel?.id, channel?.libraryTrackId, channel?.url, useChromeSeek]);

  /** Keep chrome seek bar in sync (native `<video>` controls hidden for these modes). */
  useEffect(() => {
    if (!useChromeSeek) {
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
      if (isLibraryChannel) {
        const trackId = channel?.libraryTrackId?.trim();
        if (trackId) dispatchLibraryAudioState(trackId, el.paused);
      }
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
  }, [useChromeSeek, isLibraryChannel, channel?.id, channel?.url, channel?.libraryTrackId]);

  useEffect(() => {
    if (!isLibraryChannel) return;
    const trackId = channel?.libraryTrackId?.trim();
    if (!trackId) return;
    const onToggle = (ev: Event) => {
      const detail = (ev as CustomEvent<{ trackId?: string }>).detail;
      if (detail?.trackId !== trackId) return;
      const el = mediaRef.current;
      if (!el) return;
      if (el.paused) void el.play().catch(() => {});
      else el.pause();
    };
    window.addEventListener(LIBRARY_AUDIO_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(LIBRARY_AUDIO_TOGGLE_EVENT, onToggle);
  }, [isLibraryChannel, channel?.id, channel?.libraryTrackId]);

  useEffect(() => {
    const stopLibraryMedia = () => {
      const el = mediaRef.current;
      if (!el) return;
      el.pause();
      releaseEqForMediaElement(el, volume);
      setEqActive(false);
      el.removeAttribute("src");
      el.querySelectorAll("source[data-iptv-library]").forEach((node) => node.remove());
      el.load();
    };
    window.addEventListener(LIBRARY_CLEARED_EVENT, stopLibraryMedia);
    return () => window.removeEventListener(LIBRARY_CLEARED_EVENT, stopLibraryMedia);
  }, []);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !isLibraryChannel) return;
    el.playbackRate = 1;
  }, [isLibraryChannel, channel?.id]);

  useEffect(() => {
    if (!volumePopoverOpen) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      const host = volumePopoverRef.current;
      const panel = volumeAnchoredPanelRef.current;
      const t = ev.target;
      if (!(t instanceof Node)) return;
      if (host?.contains(t)) return;
      if (panel?.contains(t)) return;
      setVolumePopoverOpen(false);
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
    if (!isInternetAudioStream) {
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
  }, [isInternetAudioStream, channel?.id]);

  const translateRadioCaptionLine = useCallback(async (segmentId: number, text: string, targetCode: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const { franc } = await import("franc-min");
      const detected = franc(trimmed, { minLength: 3 }) || "eng";
      const fetchJson = createLyricsJsonFetcher();
      const tr = await translateLineBatchesToLanguage([trimmed], targetCode, detected, fetchJson);
      const translated = tr.lines[0]?.trim() || trimmed;
      setRadioCaptionSegments((prev) =>
        prev.map((s) => (s.id === segmentId ? { ...s, translated } : s))
      );
    } catch {
      /* per-line translation failures are non-fatal */
    }
  }, []);

  const onRadioCaptionTranslateLanguage = useCallback(
    async (targetCode: string) => {
      if (!radioCaptionSegments.length) return;
      radioCaptionTranslateAbortRef.current?.abort();
      const ac = new AbortController();
      radioCaptionTranslateAbortRef.current = ac;
      setRadioCaptionTranslateBusy(true);
      setRadioCaptionTranslateErr(null);
      setRadioCaptionTranslateHint(null);
      const langLabel = labelForLyricsTargetCode(targetCode);
      const lines = radioCaptionSegments.map((s) => s.text);
      try {
        const sample = lines.join("\n").slice(0, 3500);
        const { franc } = await import("franc-min");
        const detected = franc(sample, { minLength: 10 }) || "eng";
        const fetchJson = createLyricsJsonFetcher();
        const tr = await translateLineBatchesToLanguage(lines, targetCode, detected, fetchJson, ac.signal);
        if (ac.signal.aborted) return;
        setRadioCaptionSegments((prev) =>
          prev.map((s, i) => ({ ...s, translated: tr.lines[i]?.trim() || s.text }))
        );
        setRadioCaptionTranslateTarget(targetCode);
        setRadioCaptionTranslateHint(
          tr.providerHint ? `Translated to ${langLabel} · ${tr.providerHint}` : `Translated to ${langLabel}`
        );
      } catch (e) {
        if (ac.signal.aborted) return;
        setRadioCaptionTranslateErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ac.signal.aborted) setRadioCaptionTranslateBusy(false);
      }
    },
    [radioCaptionSegments]
  );

  useEffect(() => {
    if (!isRadioChannel || !radioCaptionsEnabled || !radioPlaying || !canUseRadioLiveCaptions()) {
      radioCaptionsCtrlRef.current?.stop();
      radioCaptionsCtrlRef.current = null;
      return;
    }
    const el = mediaRef.current;
    if (!el) return;
    setRadioCaptionsErr(null);
    const ctrl = startRadioLiveCaptions(el, {
      onStatus: setRadioCaptionsStatus,
      onSegment: (seg) => {
        setRadioCaptionSegments((prev) => {
          if (seg.replaceLast && prev.length > 0) {
            const next = [...prev];
            const last = next[next.length - 1]!;
            next[next.length - 1] = {
              ...last,
              text: seg.text,
              at: seg.at,
              id: seg.id,
            };
            return next;
          }
          return [...prev.slice(-40), seg];
        });
        const target = radioCaptionTranslateTargetRef.current;
        if (target) void translateRadioCaptionLine(seg.id, seg.text, target);
      },
      onError: (msg) => setRadioCaptionsErr(msg),
    });
    radioCaptionsCtrlRef.current = ctrl;
    return () => {
      ctrl.stop();
      radioCaptionsCtrlRef.current = null;
    };
  }, [isRadioChannel, radioCaptionsEnabled, radioPlaying, channel?.id, translateRadioCaptionLine]);

  useEffect(() => {
    if (!channel?.id || isEbookChannel || isEmbeddedWebChannel) return;
    const el = mediaRef.current;
    if (!el) return;
    const channelId = channel.id;
    const sync = () => dispatchMediaPlaybackState(channelId, el.paused);
    sync();
    el.addEventListener("playing", sync);
    el.addEventListener("play", sync);
    el.addEventListener("pause", sync);
    el.addEventListener("ended", sync);
    return () => {
      el.removeEventListener("playing", sync);
      el.removeEventListener("play", sync);
      el.removeEventListener("pause", sync);
      el.removeEventListener("ended", sync);
    };
  }, [channel?.id, isEbookChannel, isEmbeddedWebChannel]);

  useEffect(() => {
    if (!channel?.id || isEbookChannel || isEmbeddedWebChannel) return;
    const channelId = channel.id;
    const onToggle = (ev: Event) => {
      const detail = (ev as CustomEvent<{ channelId?: string }>).detail;
      if (detail?.channelId !== channelId) return;
      const el = mediaRef.current;
      if (!el) return;
      if (el.paused) void el.play().catch(() => {});
      else el.pause();
    };
    window.addEventListener(MEDIA_PLAYBACK_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(MEDIA_PLAYBACK_TOGGLE_EVENT, onToggle);
  }, [channel?.id, isEbookChannel, isEmbeddedWebChannel]);

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
    const tid = channel?.libraryTrackId?.trim();
    if (!tid || !channel || !isLikelyLocalMp3Channel(channel)) {
      setLyricsCoverUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const row = await getAudioLibraryTrackById(tid);
        const blob =
          row?.coverArt instanceof Blob && row.coverArt.size > 0 ? row.coverArt : null;
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setLyricsCoverUrl(objectUrl);
      } catch {
        if (!cancelled) setLyricsCoverUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          /* noop */
        }
      }
      setLyricsCoverUrl(null);
    };
  }, [channel?.id, channel?.libraryTrackId]);

  useEffect(() => {
    const ch = channel;
    if (!ch || !isLikelyLocalMp3Channel(ch)) {
      setMp3Lyrics({ kind: "idle" });
      return;
    }
    const ac = new AbortController();
    const run = async () => {
      const tid = ch.libraryTrackId?.trim();
      const fileMeta = await resolveTrackMetadataFromLibrary(ch.name, tid);

      if (tid && typeof indexedDB !== "undefined") {
        try {
          const cached = await getLibraryLyricsCache(tid);
          if (
            isUsableSavedLyricsCache(cached, {
              metaArtist: fileMeta.artist,
              metaTitle: fileMeta.title,
            }) &&
            !ac.signal.aborted
          ) {
            apiOnlyLyricsPreviewRef.current = false;
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
        if (!ac.signal.aborted) {
          apiOnlyLyricsPreviewRef.current = false;
          setMp3Lyrics({ kind: "ready", data });
        }
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
    if (!artist && !title && !album) return null;
    return {
      artist,
      title,
      album,
    };
  }, [mp3Lyrics, lyricsTrackMeta]);

  const lyricsSourceSummary = useMemo(() => {
    if (mp3Lyrics.kind !== "ready" || !mp3Lyrics.data.pairs.length) return null;
    const data = mp3Lyrics.data;
    const llmLyrics =
      data.lyricsLlmModel && data.lyricsLlmHost
        ? formatLlmUsageLine(
            data.lyricsLlmPurpose || "lyrics find + translate",
            data.lyricsLlmModel,
            data.lyricsLlmHost
          )
        : "";
    const originalSource = llmLyrics
      ? llmLyrics
      : data.lrclibTrack
        ? `LRCLIB (${data.lrclibTrack})`
        : "Local database / unknown source";
    const translationSource =
      lyricsOverridePairs && lyricsTranslateTarget
        ? `${labelForLyricsTargetCode(lyricsTranslateTarget)} translation - ${
            lyricsTranslateHint?.replace(/^Translated to\s+[^·]+(?:\s+·\s+)?/i, "").trim() ||
            "current override"
          }`
        : llmLyrics
          ? llmLyrics
          : data.pairs.every((p) => p.orig.trim() === p.en.trim())
            ? "Original text (no separate translation)"
            : "Free translators / same-language fallback";
    const meaningSource =
      data.songMeaningLlmModel && data.songMeaningLlmHost
        ? `${formatLlmUsageLine(
            data.songMeaningLlmPurpose || "song meaning",
            data.songMeaningLlmModel,
            data.songMeaningLlmHost
          )}${data.songMeaning ? " - loaded" : data.songMeaningError ? " - failed" : ""}`
        : data.songMeaning
          ? "Local database (provider not recorded)"
          : data.songMeaningError
            ? "Not loaded - error"
            : songMeaningLoading
              ? "Loading"
              : "Not loaded";
    return {
      originalSource,
      translationSource,
      meaningSource,
    };
  }, [
    lyricsOverridePairs,
    lyricsTranslateHint,
    lyricsTranslateTarget,
    mp3Lyrics,
    songMeaningLoading,
  ]);

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
  }, [channel?.id]);

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
      const tid = channel?.libraryTrackId?.trim() || "";
      const langLabel = labelForLyricsTargetCode(targetCode);
      try {
        if (tid && typeof indexedDB !== "undefined") {
          try {
            const cached = await getLibraryLyricsTranslationCache(tid, targetCode);
            if (cached?.pairs?.length && !ac.signal.aborted) {
              setLyricsOverridePairs(cached.pairs);
              setLyricsTranslateTarget(targetCode);
              setLyricsTranslateHint(`Translated to ${langLabel} · loaded from local cache`);
              return;
            }
          } catch {
            /* ignore cache read failures */
          }
        }
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
        setLyricsTranslateHint(
          tr.providerHint ? `Translated to ${langLabel} · ${tr.providerHint}` : `Translated to ${langLabel}`
        );
        if (tid && typeof indexedDB !== "undefined") {
          void putLibraryLyricsTranslationCache(tid, targetCode, pairs).catch(() => {});
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setLyricsTranslateErr(e instanceof Error ? e.message : String(e));
        setLyricsOverridePairs(null);
        setLyricsTranslateTarget(null);
      } finally {
        if (!ac.signal.aborted) setLyricsTranslateBusy(false);
      }
    },
    [channel?.libraryTrackId, mp3Lyrics]
  );

  const loadLyricsFromLocalDbOnly = useCallback(async () => {
    const ch = channel;
    const tid = ch?.libraryTrackId?.trim() || "";
    if (!ch || !isLikelyLocalMp3Channel(ch) || !tid || typeof indexedDB === "undefined") {
      setPlayerChromeNotice("No local lyrics database is available for this track.");
      return;
    }
    setMp3LyricsHidden(false);
    apiOnlyLyricsPreviewRef.current = false;
    setMp3Lyrics({ kind: "loading" });
    try {
      const cached = await getLibraryLyricsCache(tid);
      if (cached?.pairs?.length) {
        setMp3Lyrics({ kind: "ready", data: mapCachedLibraryLyricsToResult(cached) });
        setPlayerChromeNotice("Loaded lyrics and meaning from the local database.");
        return;
      }
      setMp3Lyrics({ kind: "error", message: "No saved lyrics found in the local database for this track." });
      setPlayerChromeNotice("No saved local lyrics found for this track.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMp3Lyrics({ kind: "error", message: msg || "Could not read saved lyrics." });
    }
  }, [channel]);

  const fetchLyricsFromDeepSeekOnly = useCallback(async () => {
    const ch = channel;
    if (!ch || !isLikelyLocalMp3Channel(ch)) return;
    const el = mediaRef.current;
    const inline = el?.duration;
    const inlineOk = typeof inline === "number" && Number.isFinite(inline) && inline > 2 ? inline : null;
    const durationSec =
      lyricsDurationKey != null && lyricsDurationKey > 2 ? lyricsDurationKey : inlineOk;
    setMp3LyricsHidden(false);
    apiOnlyLyricsPreviewRef.current = true;
    setMp3Lyrics({ kind: "loading" });
    setPlayerChromeNotice("Fetching lyrics and meaning from DeepSeek only; local database will not be changed.");
    try {
      const data = await fetchDeepSeekLyricsForLocalMp3(ch.name, durationSec, undefined, {
        libraryTrackId: ch.libraryTrackId?.trim(),
        saveToCache: false,
      });
      apiOnlyLyricsPreviewRef.current = true;
      setMp3Lyrics({ kind: "ready", data });
      setPlayerChromeNotice("Fetched from DeepSeek only. Use Save lyrics if this version is better.");
    } catch (e) {
      setMp3Lyrics({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [channel, lyricsDurationKey]);

  const fetchLyricsFromGeminiOnly = useCallback(async () => {
    const ch = channel;
    if (!ch || !isLikelyLocalMp3Channel(ch)) return;
    const el = mediaRef.current;
    const inline = el?.duration;
    const inlineOk = typeof inline === "number" && Number.isFinite(inline) && inline > 2 ? inline : null;
    const durationSec =
      lyricsDurationKey != null && lyricsDurationKey > 2 ? lyricsDurationKey : inlineOk;
    setMp3LyricsHidden(false);
    apiOnlyLyricsPreviewRef.current = true;
    setMp3Lyrics({ kind: "loading" });
    setPlayerChromeNotice("Fetching lyrics and meaning from Gemini only; local database will not be changed.");
    try {
      const data = await fetchGeminiLyricsForLocalMp3(ch.name, durationSec, undefined, {
        libraryTrackId: ch.libraryTrackId?.trim(),
        saveToCache: false,
      });
      apiOnlyLyricsPreviewRef.current = true;
      setMp3Lyrics({ kind: "ready", data });
      setPlayerChromeNotice("Fetched from Gemini only. Use Save lyrics if this version is better.");
    } catch (e) {
      setMp3Lyrics({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [channel, lyricsDurationKey]);

  const saveShownLyricsToLocalDb = useCallback(async () => {
    const ch = channel;
    const tid = ch?.libraryTrackId?.trim() || "";
    if (!tid || mp3Lyrics.kind !== "ready" || !mp3Lyrics.data.pairs.length) {
      setPlayerChromeNotice("No loaded lyrics to save for this track.");
      return;
    }
    try {
      const saved = await saveLocalMp3LyricsResultToCache(tid, mp3Lyrics.data, { manualSaved: true });
      if (!saved) {
        setPlayerChromeNotice("Could not save lyrics to the local database.");
        return;
      }
      if (lyricsOverridePairs?.length && lyricsTranslateTarget) {
        await putLibraryLyricsTranslationCache(tid, lyricsTranslateTarget, lyricsOverridePairs);
      }
      apiOnlyLyricsPreviewRef.current = false;
      setMp3Lyrics({ kind: "ready", data: { ...mp3Lyrics.data, manualSaved: true } });
      setPlayerChromeNotice("Saved the current lyrics and meaning to the local database.");
    } catch (e) {
      setPlayerChromeNotice(e instanceof Error ? e.message : "Could not save lyrics to the local database.");
    }
  }, [channel, lyricsOverridePairs, lyricsTranslateTarget, mp3Lyrics]);

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
    if (apiOnlyLyricsPreviewRef.current) {
      setSongMeaningLoading(false);
      return;
    }
    if (data.manualSaved || data.fromLocalCache) {
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
    readyLyricsMeaning,
    readyLyricsMeaningError,
    readyLyrics?.pairs.length,
  ]);

  const canStartRecording = recordable && streamOkForRecord && hasDesktopRecordApi && !isYoutubeChannel && !isEbookChannel;
  /** Hide REC and related chrome for local library audio, ebooks, and YouTube embeds. */
  const showRecordChrome = recordable && !isLibraryChannel && !isYoutubeChannel && !isEbookChannel;
  const showScreenOffChrome = !!channel && !isLibraryChannel && !isInternetAudioStream && !isEbookChannel && !isEmbeddedWebChannel;
  const effectiveRecordTapPlayUrl =
    recordingSourceUrl && channel?.url?.trim() === recordingSourceUrl ? recordTapPlayUrl : null;

  const recordButtonTitle = !recordable
    ? ""
    : !hasDesktopRecordApi
      ? "Record live stream to a folder you choose — install the Player Windows desktop app."
      : !streamOkForRecord
        ? isWebVideoPageChannel
            ? "This web page is not a direct media stream, so the app cannot record it. Paste a direct .mp4, .webm, .ts, or similar media URL instead."
          : isInternetAudioStream
            ? "This stream URL cannot be recorded from the app unless it is a direct http(s) media stream."
            : "REC needs a direct http(s) media stream URL, not an embedded website page."
        : isInternetAudioStream
          ? "Save the live audio stream to disk (same bytes as playback via one upstream on desktop)."
          : "Save the live IPTV stream, then finalize it as a quality-preserving .mp4 after Stop. Playback stays on the live stream while recording.";

  useEffect(() => {
    onRecordingStatusChangeRef.current?.(recording);
  }, [recording]);

  useEffect(() => {
    return () => {
      const id = recordIdRef.current;
      if (id && window.iptv?.stopStreamRecord) {
        void window.iptv.stopStreamRecord(id);
      }
      recordIdRef.current = null;
      onRecordingStatusChangeRef.current?.(false);
      setRecording(false);
      setRecordTapPlayUrl(null);
      setRecordingSourceUrl(null);
      setRecordSavedPath(null);
    };
  }, []);

  useEffect(() => {
    if (screenPlaybackOff) {
      setBufferLine(recording ? "Screen off · recording continues" : "Screen off");
      return;
    }
    if (!channel?.url?.trim() || isLibraryChannel || isEbookChannel) {
      setBufferLine("—");
      return;
    }
    const last = { ahead: 0, ts: performance.now() };
    let lastLine = "—";
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
      const line = formatBufferStatsLine({ aheadSec: ahead, fillSs, levelKbps });
      if (line !== lastLine) {
        lastLine = line;
        setBufferLine(line);
      }
    };
    tick();
    const id = window.setInterval(tick, 450);
    return () => clearInterval(id);
  }, [channel?.url, recording, screenPlaybackOff, isLibraryChannel, isEbookChannel]);

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
      setRecordErr(null);
      setScreenPlaybackOff(false);
      if (!recordIdRef.current) {
        setRecording(false);
        setRecordSavedPath(null);
        setRecordingSourceUrl(null);
      }
    }

    hlsRef.current?.destroy();
    hlsRef.current = null;
    mpegtsRef.current?.destroy();
    mpegtsRef.current = null;
    if (externalUrlRef.current) {
      URL.revokeObjectURL(externalUrlRef.current);
      externalUrlRef.current = null;
    }
    const scope = eqPageScopeForChannel(channel);
    handoffEqScope(video, scope, volumeRef.current);
    setEqActive(false);
    video.removeAttribute("src");
    video.querySelectorAll("source[data-iptv-library]").forEach((node) => node.remove());
    video.querySelectorAll("track[data-iptv-external]").forEach((node) => node.remove());
    video.load();

    setError(null);
    setPlaybackMode(null);
    setTrackOptions([]);
    setSelectedTrack("off");

    if (channel?.ebookId) return;
    if (channel?.youtubeVideoId || channel?.webVideoPageUrl) return;

    if (!channel?.url) return;

    const url = channel.url.trim();
    if (!url) {
      setError("Empty stream URL.");
      return;
    }

    const el = video;

    let skipDefaultFinish = false;

    const onTracks = () => refreshTextTracks();

    const proxyBase = streamProxyOrigin?.trim() || undefined;

    let effectLive = true;
    let mpegtsTransientRetries = 0;
    let mpegtsRetryTimer: number | null = null;
    let nativeFallbackTried = false;

    /** IPTV-only: if nothing useful loads in 15s, show a simple error (unless a more specific error is already set). */
    let iptvLoadTimer: number | null = null;
    let iptvLoadReadyCleanup: (() => void) | null = null;
    const clearIptvLoadWatch = () => {
      if (iptvLoadTimer != null) {
        clearTimeout(iptvLoadTimer);
        iptvLoadTimer = null;
      }
      iptvLoadReadyCleanup?.();
      iptvLoadReadyCleanup = null;
    };
    const startIptvLoadWatch = () => {
      clearIptvLoadWatch();
      const onVideoProgress = () => {
        if (!effectLive) return;
        clearIptvLoadWatch();
      };
      el.addEventListener("playing", onVideoProgress);
      el.addEventListener("loadeddata", onVideoProgress);
      el.addEventListener("canplay", onVideoProgress);
      iptvLoadReadyCleanup = () => {
        el.removeEventListener("playing", onVideoProgress);
        el.removeEventListener("loadeddata", onVideoProgress);
        el.removeEventListener("canplay", onVideoProgress);
      };
      iptvLoadTimer = window.setTimeout(() => {
        iptvLoadTimer = null;
        iptvLoadReadyCleanup?.();
        iptvLoadReadyCleanup = null;
        if (!effectLive) return;
        setError((prev) => prev ?? "Can't load the channel.");
      }, 15_000);
    };

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
        clearIptvLoadWatch();
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
              startIptvLoadWatch();
              void el.play().catch(() => {});
            }
          }, delay);
          return;
        }

        if (mpegTsIsFormatUnsupported(type, detail, extra) && !nativeFallbackTried && !tapPlayUrl?.trim()) {
          clearIptvLoadWatch();
          setError(null);
          if (
            typeof window.iptv?.prepareMkvPlayback === "function" &&
            needsDesktopFfmpegPlayback(streamUrl)
          ) {
            mpegtsRef.current?.destroy();
            mpegtsRef.current = null;
            startDesktopRemuxPlayback(streamUrl);
            return;
          }
          if (tryNativeDirectPlayback(streamUrl)) return;
        }

        clearIptvLoadWatch();
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

    const tryNativeDirectPlayback = (streamUrl: string, mode: PlaybackModeLabel = "Native · direct"): boolean => {
      if (!/^https?:\/\//i.test(streamUrl)) return false;
      nativeFallbackTried = true;
      try {
        mpegtsRef.current?.destroy();
        mpegtsRef.current = null;
        el.pause();
        el.removeAttribute("src");
        el.load();
        function onNativeLoadedMeta() {
          el.removeEventListener("error", onNativeError);
          clearIptvLoadWatch();
          onTracks();
        }
        function onNativeError() {
          el.removeEventListener("loadedmetadata", onNativeLoadedMeta);
          clearIptvLoadWatch();
          setPlaybackMode(null);
          setError(
            "This URL is not MPEG-TS/FLV and the browser could not play it directly. It may be an HTML login/error page, an unsupported codec, or a provider URL that needs an HLS (.m3u8) variant."
          );
        }
        nativeErrCleanup = () => {
          el.removeEventListener("error", onNativeError);
          el.removeEventListener("loadedmetadata", onNativeLoadedMeta);
        };
        el.addEventListener("error", onNativeError, { once: true });
        el.addEventListener("loadedmetadata", onNativeLoadedMeta, { once: true });
        setPlaybackMode(mode);
        el.src = effectiveRecordTapPlayUrl?.trim() || streamUrl;
        startIptvLoadWatch();
        void el.play().catch(() => {});
        return true;
      } catch {
        return false;
      }
    };

    const startDesktopRemuxPlayback = (sourceUrl: string) => {
      if (typeof window === "undefined" || typeof window.iptv?.prepareMkvPlayback !== "function") return;
      skipDefaultFinish = true;
      setPlaybackMode("MKV · preparing…");
      setError(null);
      const bindPreparedMkvHls = (
        manifestSrc: string,
        r: { fromCache?: boolean; remuxed?: boolean; usedTranscode?: boolean }
      ) => {
        clearIptvLoadWatch();
        mpegtsRef.current?.destroy();
        mpegtsRef.current = null;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        el.removeAttribute("src");
        el.querySelectorAll("source[data-iptv-mkv]").forEach((node) => node.remove());
        el.load();

        if (r.fromCache) setPlaybackMode("MKV · HLS (cache)");
        else if (r.remuxed) setPlaybackMode("MKV · HLS (remux)");
        else if (r.usedTranscode) setPlaybackMode("MKV · HLS (transcoded)");
        else setPlaybackMode("MKV · HLS");
        setError(null);

        const hls = new Hls({
          enableWebVTT: true,
          renderTextTracksNatively: true,
          lowLatencyMode: false,
          maxBufferLength: 120,
          maxMaxBufferLength: 600,
          manifestLoadingTimeOut: 120_000,
          levelLoadingTimeOut: 120_000,
          fragLoadingTimeOut: 120_000,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          clearIptvLoadWatch();
          onTracks();
        });
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, onTracks);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          clearIptvLoadWatch();
          setPlaybackMode(null);
          setError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? "Network error while loading remuxed MKV (HLS). Check your connection and playlist login."
              : "Could not play this remuxed MKV stream in HLS mode."
          );
        });
        nativeErrCleanup = () => {
          hls.destroy();
          hlsRef.current = null;
          el.removeAttribute("src");
          el.querySelectorAll("source[data-iptv-mkv]").forEach((node) => node.remove());
        };
        hls.attachMedia(el);
        hls.loadSource(manifestSrc);
        startIptvLoadWatch();
        void el.play().catch(() => {});
      };

      const bindPreparedMkv = (
        playUrl: string,
        r: {
          fromCache?: boolean;
          remuxed?: boolean;
          usedTranscode?: boolean;
          playbackFormat?: string;
        }
      ) => {
        if (r.playbackFormat === "hls" || /\.m3u8(\?|#|$)/i.test(playUrl)) {
          bindPreparedMkvHls(playUrl, r);
          return;
        }
        clearIptvLoadWatch();
        if (r.fromCache) setPlaybackMode("MKV · MP4 (cache)");
        else if (r.remuxed) setPlaybackMode("MKV · MP4 (remux)");
        else if (r.usedTranscode) setPlaybackMode("MKV · MP4 (transcoded)");
        else setPlaybackMode("MKV · MP4");
        setError(null);
        function onMkvReady() {
          el.removeEventListener("error", onMkvError);
          clearIptvLoadWatch();
          onTracks();
        }
        function onMkvError() {
          el.removeEventListener("loadedmetadata", onMkvReady);
          el.removeEventListener("loadeddata", onMkvReady);
          el.removeEventListener("canplay", onMkvReady);
          clearIptvLoadWatch();
          setPlaybackMode(null);
          setError(
            "Video was remuxed but could not play in the browser yet. Wait a few seconds and try again, or check your playlist login and connection to the provider."
          );
        }
        nativeErrCleanup = () => {
          el.removeEventListener("error", onMkvError);
          el.removeEventListener("loadedmetadata", onMkvReady);
          el.removeEventListener("loadeddata", onMkvReady);
          el.removeEventListener("canplay", onMkvReady);
          el.removeAttribute("src");
          el.querySelectorAll("source[data-iptv-mkv]").forEach((node) => node.remove());
        };
        el.addEventListener("error", onMkvError, { once: true });
        el.addEventListener("loadedmetadata", onMkvReady);
        el.addEventListener("loadeddata", onMkvReady);
        el.addEventListener("canplay", onMkvReady);
        el.removeAttribute("src");
        el.querySelectorAll("source[data-iptv-mkv]").forEach((node) => node.remove());
        const srcEl = document.createElement("source");
        srcEl.setAttribute("data-iptv-mkv", "1");
        srcEl.src = playUrl;
        srcEl.type = "video/mp4";
        el.appendChild(srcEl);
        el.load();
        startIptvLoadWatch();
        void el.play().catch(() => {});
      };
      void window.iptv
        .prepareMkvPlayback(sourceUrl)
        .then((r) => {
          if (!effectLive) return;
          const playUrl =
            typeof r?.playUrl === "string" && r.playUrl.trim() ? r.playUrl.trim() : sourceUrl;
          bindPreparedMkv(playUrl, r ?? {});
        })
        .catch((e) => {
          if (!effectLive) return;
          clearIptvLoadWatch();
          setPlaybackMode(null);
          const msg = e instanceof Error ? e.message : String(e);
          setError(
            msg.includes("ffmpeg")
              ? `VOD prepare failed: ${msg}`
              : msg ||
                  "Could not prepare this movie for playback. Check that the stream URL is valid and your playlist login still works."
          );
        });
    };

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
      const srcEl = document.createElement("source");
      srcEl.setAttribute("data-iptv-library", "1");
      srcEl.src = url;
      const typeHint = channel.libraryContentType?.trim();
      if (typeHint) srcEl.type = typeHint;
      el.appendChild(srcEl);

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
        isMatroskaUrl(url) && typeof window !== "undefined" && typeof window.iptv?.prepareMkvPlayback === "function";

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
            onTracks();
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
          clearIptvLoadWatch();
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
            clearIptvLoadWatch();
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
                clearIptvLoadWatch();
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
                clearIptvLoadWatch();
                setError("Playback error (decoder could not recover).");
              }
              return;
            }
            clearIptvLoadWatch();
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
            clearIptvLoadWatch();
            setError(
              `Stream error (${data.type}${data.details ? `: ${data.details}` : ""}). The playlist or segments may be invalid or temporarily unavailable.`
            );
            return;
          }

          if (data.type === Hls.ErrorTypes.KEY_SYSTEM_ERROR) {
            clearIptvLoadWatch();
            setError("DRM / key system error — this stream may require authorization or a different player.");
            return;
          }

          clearIptvLoadWatch();
          setError(
            `Playback error (${data.type}${data.details ? `: ${data.details}` : ""}). Try another channel or ask your provider for a stable HLS feed.`
          );
        });
        hls.attachMedia(el);
        hls.loadSource(manifestSrc);
        startIptvLoadWatch();
        setPlaybackMode(splitHlsViaLocalProxy ? "HLS · hls.js · split proxy" : "HLS · hls.js");
      } else if (canPlayNativeHls(el as HTMLVideoElement)) {
        el.src = url;
        el.addEventListener("loadedmetadata", onTracks, { once: true });
        startIptvLoadWatch();
        setPlaybackMode("HLS · native");
      } else {
        setPlaybackMode("HLS · blocked");
        setError("HLS is not supported in this browser.");
        return;
      }
    } else if (isInternetAudioStream && !isLikelyHls(url)) {
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
        setError("Could not play this audio stream URL in the browser.");
      }
      el.addEventListener("error", onRadioError, { once: true });
      el.addEventListener("loadedmetadata", onRadioLoadedMeta, { once: true });
      nativeErrCleanup = () => {
        el.removeEventListener("error", onRadioError);
        el.removeEventListener("loadedmetadata", onRadioLoadedMeta);
      };
      const radioPlay = effectiveRecordTapPlayUrl?.trim() || url;
      setPlaybackMode(effectiveRecordTapPlayUrl ? (isPodcastChannel ? "Podcast · record tap" : "Radio · record tap") : isPodcastChannel ? "Podcast · native" : "Radio · native");
      el.src = radioPlay;
      const primeInternetAudio = () => {
        void ensureElementPlaybackAudible(el, volumeRef.current);
      };
      el.addEventListener("loadeddata", primeInternetAudio);
      el.addEventListener("canplay", primeInternetAudio);
      el.addEventListener("playing", primeInternetAudio);
      const prevNativeCleanup = nativeErrCleanup;
      nativeErrCleanup = () => {
        prevNativeCleanup?.();
        el.removeEventListener("loadeddata", primeInternetAudio);
        el.removeEventListener("canplay", primeInternetAudio);
        el.removeEventListener("playing", primeInternetAudio);
      };
    } else if (isLikelyMpegTsOverHttp(url)) {
      if (isLikelyProgressiveVideoUrl(url)) {
        tryNativeDirectPlayback(url, effectiveRecordTapPlayUrl ? "Native · record tap" : "Native · direct");
        skipDefaultFinish = true;
      } else if (!mpegts.isSupported()) {
        setPlaybackMode("MPEG-TS · blocked");
        setError(
          "This channel looks like MPEG-TS. This browser does not support the in-page TS player (mpegts.js). Try Chrome/Edge, or ask your provider for an HLS (m3u8) playlist."
        );
        return;
      } else if (!bindMpegTsPlayer(url, effectiveRecordTapPlayUrl)) {
        setPlaybackMode("MPEG-TS · blocked");
        setError("Could not start the MPEG-TS player in this browser.");
        return;
      } else {
        startIptvLoadWatch();
        setPlaybackMode("MPEG-TS · mpegts.js");
      }
    } else if (needsDesktopFfmpegPlayback(url)) {
      if (typeof window.iptv?.prepareMkvPlayback === "function") {
        startDesktopRemuxPlayback(url);
      } else {
        setPlaybackMode("VOD · blocked");
        setError(
          "This movie/VOD link needs the desktop app (Electron) with FFmpeg to remux MKV or provider VOD streams. Live .ts channels still work in the browser."
        );
        return;
      }
    } else if (!/^https?:\/\//i.test(url)) {
      setPlaybackMode("URL · blocked");
      setError("This URL scheme is not supported in the browser player (use http(s) streams).");
      return;
    } else {
      /** Many IPTV URLs look like normal https links but are MPEG-TS; Firefox then shows a MIME error on a plain video src. Try native first, then mpegts.js. */
      function onNativeLoadedMeta() {
        el.removeEventListener("error", onNativeError);
        clearIptvLoadWatch();
        onTracks();
      }
      function onNativeError() {
        el.removeEventListener("loadedmetadata", onNativeLoadedMeta);
        clearIptvLoadWatch();
        el.removeAttribute("src");
        el.load();
        if (mpegts.isSupported() && bindMpegTsPlayer(url, effectiveRecordTapPlayUrl)) {
          setPlaybackMode("MPEG-TS · mpegts.js");
          setError(null);
          startIptvLoadWatch();
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
      setPlaybackMode(effectiveRecordTapPlayUrl ? "Native · record tap" : "Native · direct");
      const nativePlay = effectiveRecordTapPlayUrl?.trim() || url;
      el.src = nativePlay;
      startIptvLoadWatch();
    }

    if (!skipDefaultFinish) {
      el.addEventListener("addtrack", onTracks as EventListener);

      void el.play().catch(() => {
        /* autoplay policy — user can press play */
      });
    }

    return () => {
      effectLive = false;
      clearIptvLoadWatch();
      if (mpegtsRetryTimer != null) {
        clearTimeout(mpegtsRetryTimer);
        mpegtsRetryTimer = null;
      }
      nativeErrCleanup?.();
      nativeErrCleanup = null;
      try {
        el.pause();
      } catch {
        /* noop */
      }
      releaseEqForMediaElement(el, volumeRef.current);
      el.removeEventListener("addtrack", onTracks as EventListener);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      mpegtsRef.current?.destroy();
      mpegtsRef.current = null;
      if (externalUrlRef.current) {
        URL.revokeObjectURL(externalUrlRef.current);
        externalUrlRef.current = null;
      }
      el.removeAttribute("src");
      el.querySelectorAll("source[data-iptv-library], source[data-iptv-local-video]").forEach((node) =>
        node.remove()
      );
      el.load();
    };
  }, [
    channel,
    refreshTextTracks,
    effectiveRecordTapPlayUrl,
    streamProxyOrigin,
    splitIsolateNetwork,
    channel?.streamResetNonce,
  ]);

  useEffect(() => {
    setPlayerChromeNotice(null);
  }, [channel?.id]);

  useEffect(() => {
    const v = mediaRef.current;
    if (!v) return;
    const vol = typeof volume === "number" && Number.isFinite(volume) ? volume : 1;
    const clamped = Math.min(1, Math.max(0, vol));
    void ensureElementPlaybackAudible(v, clamped);
  }, [volume, channel?.id, eqActive]);

  useEffect(() => {
    const v = mediaRef.current;
    if (!v || !isInternetAudioStream) return;
    const prime = () => {
      const vol = typeof volume === "number" && Number.isFinite(volume) ? volume : 1;
      void ensureElementPlaybackAudible(v, Math.min(1, Math.max(0, vol)));
    };
    v.addEventListener("playing", prime);
    v.addEventListener("loadeddata", prime);
    v.addEventListener("canplay", prime);
    return () => {
      v.removeEventListener("playing", prime);
      v.removeEventListener("loadeddata", prime);
      v.removeEventListener("canplay", prime);
    };
  }, [channel?.id, volume, isInternetAudioStream]);

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
      const recordPayload = {
        url: channel.url.trim(),
        outDir: dir,
        filenameExt: hint.filenameExt,
        tapContentType: hint.tapContentType,
        recordMode: hint.recordMode,
      };
      const out = await window.iptv!.startStreamRecord(recordPayload);
      recordIdRef.current = out.id;
      flushSync(() => {
        setRecording(true);
        setRecordSavedPath(out.filePath);
        setRecordTapPlayUrl(out.playbackUrl ?? null);
        setRecordingSourceUrl(channel.url.trim());
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
      setRecordingSourceUrl(null);
      setScreenPlaybackOff(false);
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

  const toggleInternetAudioPlayback = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const toggleChromePlayPause = useCallback(() => {
    if (isLibraryChannel) {
      toggleLibraryPlayPause();
      return;
    }
    if (isInternetAudioStream) {
      toggleInternetAudioPlayback();
      return;
    }
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, [isLibraryChannel, isInternetAudioStream, toggleLibraryPlayPause, toggleInternetAudioPlayback]);

  const playbackBadgeTitle =
    "How this stream is played: HLS via hls.js, HLS via the browser, MPEG-TS via mpegts.js (MSE), or a direct URL in the native video element.";

  const renderLibraryTrackToolCluster = () => {
    if (!channel || !isLibraryChannel) return null;
    const mp3Tools = isLikelyLocalMp3Channel(channel);
    return (
      <div className="now-row-library-cluster" role="toolbar" aria-label="Track tools">
        <button
          type="button"
          className="playback-badge playback-badge--btn"
          disabled={ytBusy || youtubeSearchQueryFromTrackName(channel.name).trim().length < 2}
          aria-busy={ytBusy}
          title="Search from the file name; desktop can open the first YouTube result in a new window."
          onClick={() => void openYoutubeForLocalMp3()}
        >
          {ytBusy ? "…" : "Find video"}
        </button>
        {mp3Tools ? (
          <>
            <button
              type="button"
              className="playback-badge playback-badge--btn"
              disabled={mp3Lyrics.kind === "loading"}
              title="Load lyrics and meaning only from the saved local database."
              onClick={() => void loadLyricsFromLocalDbOnly()}
            >
              {mp3Lyrics.kind === "loading" ? "…" : "Local lyrics"}
            </button>
            <button
              type="button"
              className="playback-badge playback-badge--btn"
              disabled={mp3Lyrics.kind === "loading"}
              title="Fetch lyrics and meaning only from DeepSeek / the OpenAI-compatible key. This does not save over the local database."
              onClick={() => void fetchLyricsFromDeepSeekOnly()}
            >
              DeepSeek
            </button>
            <button
              type="button"
              className="playback-badge playback-badge--btn"
              disabled={mp3Lyrics.kind === "loading"}
              title="Fetch lyrics and meaning only from Gemini. This does not save over the local database."
              onClick={() => void fetchLyricsFromGeminiOnly()}
            >
              Gemini
            </button>
            <button
              type="button"
              className="playback-badge playback-badge--btn"
              disabled={mp3Lyrics.kind !== "ready" || !mp3Lyrics.data.pairs.length}
              title="Save the currently shown lyrics and meaning to the local database."
              onClick={() => void saveShownLyricsToLocalDb()}
            >
              Save lyrics
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="playback-badge playback-badge--btn"
          onClick={() => skipLibraryToStart()}
          title="Jump to the beginning of this track"
        >
          Start over
        </button>
      </div>
    );
  };

  const renderChromeSeekRow = () => (
    <div className="library-seek-row" aria-label="Playback position">
      <span className="library-seek-label">Position</span>
      <div className="library-seek-main">
        <input
          type="range"
          className="library-seek-slider"
          min={0}
          max={libAudioDurationSec != null && libAudioDurationSec > 1.5 ? libAudioDurationSec : 1}
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
      <button
        type="button"
        className="library-seek-play-btn"
        title={libTransportPaused ? "Play" : "Pause"}
        aria-label={libTransportPaused ? "Play" : "Pause"}
        onClick={() => void toggleChromePlayPause()}
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
    </div>
  );

  const renderVolumeEq = (extraWrapClass?: string, opts?: { showVolume?: boolean }) => {
    const showVolume = opts?.showVolume !== false;
    if (!showVolume && !mediaEqEnabled) return null;
    if (showVolume && !onVolumeChange) return null;
    const libraryAnchored = extraWrapClass?.includes("volume-eq-wrap--library-inline") ?? false;
    const volumePanelInner = (
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
          onChange={(e) => onVolumeChange!(Number(e.currentTarget.value))}
        />
        <span className="volume-popover-readout">{Math.round(volume * 100)}%</span>
      </div>
    );
    return (
      <div
        className={`volume-eq-wrap${extraWrapClass ? ` ${extraWrapClass}` : ""}${
          !showVolume ? " volume-eq-wrap--eq-only" : ""
        }`}
      >
        {showVolume && onVolumeChange ? (
        <div className="volume-popover-host" ref={volumePopoverRef}>
          <button
            ref={volumeTriggerRef}
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
          {volumePopoverOpen && libraryAnchored ? (
            <AnchoredPopover
              open={volumePopoverOpen}
              anchorRef={volumeTriggerRef}
              panelRef={volumeAnchoredPanelRef}
              role="dialog"
              aria-label="Volume"
              align="end"
              preferAbove
              className="volume-popover-panel volume-popover-panel--anchored"
            >
              {volumePanelInner}
            </AnchoredPopover>
          ) : null}
          {volumePopoverOpen && !libraryAnchored ? (
            <div className="volume-popover-panel" role="dialog" aria-label="Volume">
              {volumePanelInner}
            </div>
          ) : null}
        </div>
        ) : null}
        <RadioEqualizer
          mediaRef={mediaRef}
          eqEnabled={mediaEqEnabled}
          eqScope={eqPageScope}
          volume={volume}
          streamKey={channel?.id}
          onEqActiveChange={setEqActive}
          anchoredPopover={libraryAnchored}
        />
      </div>
    );
  };

  return (
    <div
      className={`player-root${inSplitView ? " player-root--split" : ""}${
        layoutMode === "compactTvDock" ? " player-root--compact-tv-dock" : ""
      }${layoutMode === "compactReader" ? " player-root--compact-reader" : ""}`}
      ref={playerRootRef}
    >
      <div className="player-top">
        {!channel ? (
          <div className="player-placeholder">
            <strong>{paneLabel ? `No channel on ${paneLabel}` : "No channel selected."}</strong>
            <br />
            {paneLabel ? (
              <>
                Choose <strong>Screen 1</strong> or <strong>Screen 2</strong> under next click, then pick a channel.
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
          <div
            className={`video-wrap${layoutMode === "compactTvDock" ? " video-wrap--compact-tv-dock" : ""}${
              isEbookChannel ? " video-wrap--ebook" : ""
            }${isInternetAudioStream ? " video-wrap--internet-audio" : ""}`}
          >
            {layoutMode === "compactTvDock" && channel ? (
              <div className="compact-tv-dock-bar">
                <span className="compact-tv-dock-label">{channel.name}</span>
              </div>
            ) : null}
            {isEbookChannel ? (
              <article
                className={`ebook-player${layoutMode === "compactReader" ? " ebook-player--compact" : ""}`}
                aria-label="Ebook reader"
                ref={ebookPlayerRef}
              >
                <div className="ebook-player-page">
                  <div className="ebook-player-header">
                    <div className="ebook-player-header-content">
                      <div
                        className={`ebook-player-page-indicator${
                          ebookPageNav.unit === "chapter" && ebookPageNav.label ? " ebook-player-page-indicator--chapter" : ""
                        }`}
                        aria-live="polite"
                        aria-label={
                          ebookPageNav.label
                            ? `${ebookPageNav.label}, ${ebookReadingLabel(ebookPageNav.unit, ebookPageNav.current, ebookPageNav.total)}`
                            : ebookReadingLabel(ebookPageNav.unit, ebookPageNav.current, ebookPageNav.total)
                        }
                      >
                        {ebookPageNav.unit === "chapter" && ebookPageNav.label ? (
                          <>
                            <span className="ebook-player-page-num ebook-player-page-num--title">{ebookPageNav.label}</span>
                            <div className="ebook-player-page-meta">
                              <span className="ebook-player-page-reading">
                                Chapter {ebookPageNav.current} of {ebookPageNav.total}
                              </span>
                            </div>
                          </>
                        ) : (
                          <>
                            <span className="ebook-player-page-num">{ebookPageNav.current}</span>
                            <div className="ebook-player-page-meta">
                              <span className="ebook-player-page-reading">
                                {ebookReadingLabel(ebookPageNav.unit, ebookPageNav.current, ebookPageNav.total)}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="ebook-player-header-main">
                        <h2 className="ebook-player-title">{ebookDisplayTitle(channel.name)}</h2>
                        <p className="ebook-player-meta">{channel.ebookSourceFileName || "Local ebook"}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ebook-fullscreen-btn"
                      onClick={toggleEbookFullscreen}
                      title={ebookFullscreen ? "Exit ebook fullscreen" : "Read ebook fullscreen"}
                      aria-label={ebookFullscreen ? "Exit ebook fullscreen" : "Read ebook fullscreen"}
                    >
                      {ebookFullscreen ? "Exit Reading View" : "Reading View"}
                    </button>
                  </div>
                  {channel.ebookFormat === "pdf" ? (
                    <PdfReader
                      channel={channel}
                      pageTexts={ebookChunks}
                      ebookStartChunk={ebookStartChunk}
                      ebookSpeechBoundary={ebookSpeechBoundary}
                      ebookTtsActive={ebookTtsActive}
                      onEbookPageChange={handleEbookPageChange}
                    />
                  ) : channel.ebookFormat === "epub" && channel.ebookBlob instanceof Blob ? (
                    <EpubReader
                      channel={channel}
                      pageTexts={ebookChunks}
                      ebookStartChunk={ebookStartChunk}
                      ebookSpeechBoundary={ebookSpeechBoundary}
                      ebookTtsActive={ebookTtsActive}
                      onEbookPageChange={handleEbookPageChange}
                    />
                  ) : (
                    <EbookPlainTextPage
                      channel={channel}
                      ebookChunks={ebookChunks}
                      ebookStartChunk={ebookStartChunk}
                      ebookSpeechBoundary={ebookSpeechBoundary}
                      ebookTtsActive={ebookTtsActive}
                      onEbookPageChange={handleEbookPageChange}
                    />
                  )}
                </div>
              </article>
            ) : null}
            {channel && isInternetAudioStream ? (
              <div
                className={`internet-audio-layout${
                  isRadioChannel ? " internet-audio-layout--radio-split" : ""
                }`}
              >
                <div className="internet-audio-layout-station">
                  <InternetAudioShowcase
                    channel={channel}
                    kind={isPodcastChannel ? "podcast" : "radio"}
                    playing={radioPlaying}
                    playbackMode={playbackMode}
                    bufferLine={bufferLine}
                    onTogglePlay={toggleInternetAudioPlayback}
                  />
                </div>
                {isRadioChannel ? (
                  <div className="internet-audio-layout-captions">
                    <RadioLiveCaptionsPanel
                      layout="split"
                      enabled={radioCaptionsEnabled}
                status={radioCaptionsStatus}
                error={radioCaptionsErr}
                segments={radioCaptionSegments}
                translateBusy={radioCaptionTranslateBusy}
                translateTarget={radioCaptionTranslateTarget}
                translateHint={radioCaptionTranslateHint}
                translateErr={radioCaptionTranslateErr}
                onToggle={() => {
                  if (!radioCaptionsEnabled && !canUseRadioLiveCaptions()) {
                    setRadioCaptionsErr("Live captions need the desktop app with local Whisper.");
                    return;
                  }
                  setRadioCaptionsEnabled((on) => {
                    if (on) {
                      setRadioCaptionsStatus("");
                      setRadioCaptionsErr(null);
                    } else {
                      setRadioCaptionsStatus("");
                      setRadioCaptionsErr(null);
                    }
                    return !on;
                  });
                }}
                      onClear={() => {
                        radioCaptionTranslateAbortRef.current?.abort();
                        setRadioCaptionSegments([]);
                        setRadioCaptionsStatus("");
                        setRadioCaptionsErr(null);
                        setRadioCaptionTranslateTarget(null);
                        radioCaptionTranslateTargetRef.current = null;
                        setRadioCaptionTranslateBusy(false);
                        setRadioCaptionTranslateErr(null);
                        setRadioCaptionTranslateHint(null);
                      }}
                      onSelectTranslateLanguage={(code) => void onRadioCaptionTranslateLanguage(code)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            <video
              ref={mediaRef}
              className={`video-el${isEmbeddedWebChannel || isEbookChannel || screenPlaybackOff || isInternetAudioStream ? " video-el--hidden" : ""}`}
              controls={!useChromeSeek && !isEmbeddedWebChannel && !isEbookChannel}
              playsInline
              preload="auto"
            />
            {webVideoEmbedSrc ? (
              <iframe
                key={`${channel.id}-${channel.streamResetNonce ?? 0}`}
                className="web-video-embed"
                src={webVideoEmbedSrc}
                title={channel.name || "Web video"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : null}
            {screenPlaybackOff ? (
              <div className="screen-off-panel" role="status" aria-live="polite">
                <span className="screen-off-title">Screen off</span>
                <span className="screen-off-subtitle">
                  {recording ? "Audio and recording continue." : "Audio continues. Press Screen on to show video again."}
                </span>
              </div>
            ) : null}
            {isLibraryChannel ? (
              <div className="library-on-air-badge" role="status" aria-live="polite">
                <span
                  className={`library-on-air-dot${libTransportPaused ? " on-air-dot--paused" : ""}`}
                  aria-hidden
                />
                Audio
              </div>
            ) : isEbookChannel ? (
              <div className="library-on-air-badge" role="status" aria-live="polite">
                Ebook
              </div>
            ) : isEmbeddedWebChannel ? (
              <div className="library-on-air-badge" role="status" aria-live="polite">
                {isYoutubeChannel ? "YouTube" : "Web video"}
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
                      {lyricsSpatialFullscreen ? "Exit Focus" : "Focus"}
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
                <div className="mp3-lyrics-panel-main">
                  <div className="mp3-lyrics-col-lyrics">
                    {mp3Lyrics.kind === "loading" ? (
                      <p className="mp3-lyrics-loading">Fetching lyrics…</p>
                    ) : null}
                    {mp3Lyrics.kind === "error" ? (
                      <div className="mp3-lyrics-err-body">{mp3Lyrics.message}</div>
                    ) : null}
                    {mp3Lyrics.kind === "ready" ? (
                  <div className="mp3-lyrics-body">
                    {mp3Lyrics.data.pairs.length === 0 ? (
                      <p className="mp3-lyrics-empty">No lyrics found for this title.</p>
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
                  </div>
                    ) : null}
                  </div>
                  <aside className="mp3-lyrics-col-aside" aria-label="Album art and song meaning">
                    {lyricsDisplayMeta ? (
                      <div className="mp3-lyrics-aside-meta">
                        {lyricsDisplayMeta.title ? (
                          <p className="mp3-lyrics-aside-title">{lyricsDisplayMeta.title}</p>
                        ) : null}
                        {lyricsDisplayMeta.artist ? (
                          <p className="mp3-lyrics-aside-artist">{lyricsDisplayMeta.artist}</p>
                        ) : null}
                        {lyricsDisplayMeta.album ? (
                          <p className="mp3-lyrics-aside-album">{lyricsDisplayMeta.album}</p>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="mp3-lyrics-art-wrap">
                      {lyricsCoverUrl ? (
                        <img className="mp3-lyrics-art" src={lyricsCoverUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="mp3-lyrics-art mp3-lyrics-art--placeholder" aria-hidden>
                          ♪
                        </span>
                      )}
                    </div>
                    {mp3Lyrics.kind === "ready" &&
                    mp3Lyrics.data.pairs.length > 0 &&
                    (songMeaningLoading ||
                      mp3Lyrics.data.songMeaning ||
                      mp3Lyrics.data.songMeaningError) ? (
                      <section className="mp3-lyrics-meaning mp3-lyrics-meaning--aside" aria-label="Song meaning">
                        <h3 className="mp3-lyrics-meaning-title">What this song is about</h3>
                        <div className="mp3-lyrics-meaning-scroll">
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
                        </div>
                      </section>
                    ) : null}
                    {mp3Lyrics.kind === "ready" && lyricsSourceSummary ? (
                      <footer className="mp3-lyrics-llm-usage" aria-label="Lyrics and meaning sources">
                        <p className="mp3-lyrics-llm-usage-title">Sources</p>
                        <p className="mp3-lyrics-llm-usage-line">
                          Lyrics: {lyricsSourceSummary.originalSource}
                        </p>
                        <p className="mp3-lyrics-llm-usage-line">
                          Lyrics translation: {lyricsSourceSummary.translationSource}
                        </p>
                        <p className="mp3-lyrics-llm-usage-line">
                          Song meaning: {lyricsSourceSummary.meaningSource}
                        </p>
                      </footer>
                    ) : null}
                  </aside>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div
        className={`${inSplitView ? "player-below-video player-below-video--split" : "player-below-video"}${
          isEbookChannel ? " player-below-video--hidden" : ""
        }`}
      >
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
                {isRadioChannel ? "♪" : isPodcastChannel ? "🎙" : "TV"}
              </span>
            )}
            <div className="player-now-playing-text">
              <div className="player-now-playing-name">
                {isRadioChannel ? <span className="radio-inline-tag">Radio</span> : null}
                {isPodcastChannel ? <span className="radio-inline-tag">Podcast</span> : null}
                {isLibraryChannel ? <span className="library-inline-tag">Local audio</span> : null}
                {isLocalVideoChannel ? <span className="local-video-inline-tag">Local video</span> : null}
                {isEmbeddedWebChannel ? (
                  <span className="local-video-inline-tag">{isYoutubeChannel ? "YouTube" : "Web video"}</span>
                ) : null}
                <span className="player-now-playing-title-text">{channel.name}</span>
              </div>
              {channel.group?.trim() ? (
                <div className="player-now-playing-group">{channel.group.trim()}</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className={`player-chrome${layoutMode === "compactTvDock" || (layoutMode === "compactReader" && isEbookChannel) ? " player-chrome--hidden" : ""}`}>
        {channel ? (
          <>
              <div className={`now-row${showRecordChrome || showScreenOffChrome || recording ? " now-row--with-actions" : ""}`}>
              <div className="now-row-main">
                {paneLabel ? (
                  <span className="pane-label" title="Player pane">
                    {paneLabel}
                  </span>
                ) : null}
                {isLibraryChannel ? (
                  renderLibraryTrackToolCluster()
                ) : isRadioChannel || isPodcastChannel ? (
                  <div className="now-row-playback-cluster">
                    {playbackMode ? (
                      <span
                        className={`playback-badge${playbackMode.includes("blocked") ? " playback-badge--warn" : ""}`}
                        title={playbackBadgeTitle}
                      >
                        {playbackMode}
                      </span>
                    ) : null}
                    {renderVolumeEq("volume-eq-wrap--chrome-inline")}
                  </div>
                ) : playbackMode ? (
                  <span
                    className={`playback-badge${playbackMode.includes("blocked") ? " playback-badge--warn" : ""}`}
                    title={playbackBadgeTitle}
                  >
                    {playbackMode}
                  </span>
                ) : null}
                {(onVolumeChange && !isLibraryChannel && !isInternetAudioStream) ||
                (!isRadioChannel && !isLibraryChannel && !isEmbeddedWebChannel && !isEbookChannel) ? (
                  <div className="now-row-playback-cluster">
                    {!isRadioChannel && !isLibraryChannel && !isEmbeddedWebChannel && !isEbookChannel ? (
                      <label className="cc-toggle cc-toggle--inline">
                        <input type="checkbox" checked={ccEnabled} onChange={(e) => setCcEnabled(e.target.checked)} />
                        Show CC
                      </label>
                    ) : null}
                    {onVolumeChange && !isLibraryChannel && !isInternetAudioStream
                      ? renderVolumeEq("volume-eq-wrap--chrome-inline")
                      : null}
                  </div>
                ) : null}
              </div>
              {showRecordChrome || showScreenOffChrome || recording ? (
                <div className="now-row-actions">
                  {showRecordChrome && recordSavedPath ? (
                    canRevealRecordingInExplorer ? (
                      <button
                        type="button"
                        className="record-path record-path--compact record-path--inline record-path--link"
                        title={`${recordSavedPath}\nClick to open this folder in File Explorer and select the file`}
                        onClick={openRecordedFileInExplorer}
                      >
                        {recordSavedPath.length > 56 ? `…${recordSavedPath.slice(-52)}` : recordSavedPath}
                      </button>
                    ) : (
                      <div className="record-path record-path--compact record-path--inline" title={recordSavedPath}>
                        {recordSavedPath.length > 56 ? `…${recordSavedPath.slice(-52)}` : recordSavedPath}
                      </div>
                    )
                  ) : null}
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
                  ) : showRecordChrome ? (
                      <button
                        type="button"
                        className="rec-btn"
                        disabled={recordBusy || !canStartRecording}
                        title={recordButtonTitle}
                        onClick={() => void startRecording()}
                      >
                        REC
                      </button>
                  ) : null}
                  {showScreenOffChrome ? (
                    <button
                      type="button"
                      className={`screen-off-btn${screenPlaybackOff ? " screen-off-btn--on" : ""}`}
                      title={
                        screenPlaybackOff
                          ? "Turn the stream screen back on."
                          : recording
                            ? "Hide the video while audio playback and recording continue."
                            : "Hide the video and keep the stream audio playing."
                      }
                      aria-pressed={screenPlaybackOff}
                      onClick={() => setScreenPlaybackOff((v) => !v)}
                    >
                      {screenPlaybackOff ? "Screen on" : "Screen off"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="buffer-stats" title="Buffered seconds ahead, buffer fill rate (s/s), optional HLS level bitrate">
              {bufferLine}
            </div>
            {useChromeSeek ? (
              <>
                {renderChromeSeekRow()}
                {isLibraryChannel ? (
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
                ) : null}
              </>
            ) : null}
            {channel && !isLibraryChannel ? (
              <div className="now-url" title={isEbookChannel ? channel.ebookSourceFileName || channel.name : channel.url}>
                {isEbookChannel ? channel.ebookSourceFileName || "Local ebook" : channel.url}
              </div>
            ) : null}
            {showRecordChrome && recordErr ? <div className="record-err record-err--compact">{recordErr}</div> : null}
            {showRecordChrome && !canStartRecording && !recording && (!hasDesktopRecordApi || !streamOkForRecord) ? (
              <p className="record-hint record-hint--inline">
                {!hasDesktopRecordApi
                  ? "REC needs the Player desktop build."
                  : isWebVideoPageChannel
                    ? "REC needs a direct media URL. Embedded website pages cannot be recorded by the app."
                    : "REC needs a direct http(s) media stream URL."}
              </p>
            ) : null}
            {error ? <div className="error-banner">{error}</div> : null}
            {ytErr ? <div className="yt-search-err">{ytErr}</div> : null}
            {playerChromeNotice ? <div className="player-chrome-notice">{playerChromeNotice}</div> : null}
          </>
        ) : null}
      </div>
      </div>
    </div>
  );
}
