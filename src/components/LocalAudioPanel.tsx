import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Channel } from "../types";
import { clearAudioResume, loadAudioResumeSeconds } from "../utils/audioResumeStorage";
import {
  channelFromLibraryTrack,
  clearAudioLibrary,
  enrichStoredTrackWithCoverArt,
  fileToStoredTrack,
  listEbookLibraryItems,
  listAudioLibraryTracks,
  persistEbookLibraryItem,
  persistStoredTrack,
  removeEbookLibraryItem,
  removeAudioLibraryTrack,
  trackFromDesktopPick,
  trackHasPersistedTags,
  type PickedLocalAudioPayload,
  type StoredEbook,
  type StoredAudioTrack,
} from "../utils/audioLibraryDb";
import { extractAudioTagsDetailed } from "../utils/extractAudioMetadata";
import { extractEbookText } from "../utils/ebookText";
import { stableLocalAudioIdFromMeta } from "../utils/stableLocalAudioId";
import { LyricsChatTranslateSettings } from "./LyricsChatTranslateSettings";
import { AudioLibraryPlaybackControls } from "./AudioLibraryPlaybackControls";
import "./LocalAudioPanel.css";

const LIBRARY_AUDIO_EXTENSIONS = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|webm|mpga|mpeg)$/i;
const LIBRARY_EBOOK_EXTENSIONS = /\.(pdf|epub|txt|md|markdown|html|htm|xhtml)$/i;
const LIBRARY_ACCEPT =
  "audio/*,.mp3,.m4a,.m4b,.aac,.ogg,.oga,.opus,.wav,.flac,.webm,.mpeg,.mpga," +
  ".pdf,.epub,.txt,.md,.markdown,.html,.htm,.xhtml," +
  "application/pdf,text/plain,text/html,application/epub+zip";

function isEbookLibraryFile(fileName: string, mime = ""): boolean {
  if (LIBRARY_EBOOK_EXTENSIONS.test(fileName)) return true;
  return /application\/(pdf|epub\+zip)|text\/(plain|html)/i.test(mime);
}

function isPdfLibraryFile(fileName: string, mime = ""): boolean {
  return /\.pdf$/i.test(fileName) || mime === "application/pdf";
}

function shouldAutoOpenEbookOnImport(fileName: string, mime = ""): boolean {
  return isEbookLibraryFile(fileName, mime) && !isPdfLibraryFile(fileName, mime);
}

function isAudioLibraryFile(fileName: string, mime = ""): boolean {
  if (isEbookLibraryFile(fileName, mime)) return false;
  if (LIBRARY_AUDIO_EXTENSIONS.test(fileName)) return true;
  return /^audio\//i.test(mime);
}

function pickedLibraryFileName(payload: PickedLocalAudioPayload): string {
  return String(payload.fileName ?? "").trim() || `${payload.name}.mp3`;
}

function desktopPickToFile(payload: PickedLocalAudioPayload): File {
  const fileName = pickedLibraryFileName(payload);
  return new File([payload.data], fileName, {
    type: payload.mime || "application/octet-stream",
    lastModified: payload.lastModified || Date.now(),
  });
}

type LibraryRow = {
  track: StoredAudioTrack;
  url: string;
  thumbUrl: string | null;
  /** Native tooltip: all ID3 / Vorbis tags read from the file. */
  tagsTooltip: string | null;
  tagArtist: string;
  tagTitle: string;
};

type EbookReaderState = {
  id: string;
  title: string;
  text: string;
  status: "idle" | "preparing" | "speaking" | "paused";
  chunkIndex: number;
  chunkCount: number;
};

type EbookTtsStyle = "neutral" | "warm" | "dramatic";
type EbookSpeechSegment = {
  text: string;
  nextOffset: number;
  pauseMs: number;
  rateFactor: number;
  pitchShift: number;
};
type EbookVoiceGender = "female" | "male";
type NeuralTtsVoice = {
  id: string;
  name: string;
  language: string;
  gender: string;
  accent: string;
  grade: string;
  engine?: "kokoro-js" | "piper-vits";
};
const EBOOK_RESUME_PREFIX = "iptv-ebook-resume:";
const EBOOK_SPEECH_EVENT = "iptv-ebook-speech-boundary";
const EBOOK_TTS_ACTIVE_EVENT = "iptv-ebook-tts-active";
const EBOOK_START_EVENT = "iptv-ebook-start-at";
const EBOOK_OCR_TEXT_EVENT = "iptv-ebook-ocr-text";
const LIBRARY_AUDIO_TOGGLE_EVENT = "iptv-library-audio-toggle";
const LIBRARY_AUDIO_STATE_EVENT = "iptv-library-audio-state";
const LIBRARY_CLEARED_EVENT = "iptv-library-cleared";
const BEST_NEURAL_VOICE_ID = "af_heart";
const BEST_MALE_NEURAL_VOICE_ID = "am_michael";
const EBOOK_NEURAL_RATE = 0.92;
const EBOOK_NEURAL_VOLUME = 1;
const EBOOK_NEURAL_STYLE: EbookTtsStyle = "warm";
const EBOOK_NEURAL_RATE_KEY = "iptv-ebook-neural-rate";
const EBOOK_NEURAL_PITCH_KEY = "iptv-ebook-neural-pitch";
const EBOOK_NEURAL_GENDER_KEY = "iptv-ebook-neural-gender";
const EBOOK_TTS_SEGMENT_GROUP_COUNT = 3;
const EBOOK_TTS_PREFETCH_ENABLED = true;
const EBOOK_TTS_PREFETCH_AFTER_PROGRESS = 0.72;
const EBOOK_TTS_PREFETCH_DELAY_AFTER_PLAY_MS = 2500;
const EBOOK_TTS_PROGRESS_UPDATE_MS = 450;

function loadSavedNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: string | number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* noop */
  }
}

function loadSavedVoiceGender(): EbookVoiceGender {
  try {
    return localStorage.getItem(EBOOK_NEURAL_GENDER_KEY) === "male" ? "male" : "female";
  } catch {
    return "female";
  }
}

function isInterruptedMediaPlayError(error: unknown): boolean {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    name === "AbortError" ||
    /play\(\) request was interrupted/i.test(message) ||
    /interrupted by a call to pause/i.test(message) ||
    /interrupted by a new load request/i.test(message)
  );
}

function dispatchEbookSpeechBoundary(detail: {
  ebookId: string;
  chunkIndex: number;
  charIndex: number;
  charLength?: number;
}) {
  window.dispatchEvent(new CustomEvent(EBOOK_SPEECH_EVENT, { detail: { ...detail, pageIndex: detail.chunkIndex } }));
}

function dispatchEbookTtsActive(ebookId: string | null, active: boolean) {
  if (!ebookId) return;
  window.dispatchEvent(new CustomEvent(EBOOK_TTS_ACTIVE_EVENT, { detail: { ebookId, active } }));
}

function dispatchLibraryCleared() {
  window.dispatchEvent(new CustomEvent(LIBRARY_CLEARED_EVENT));
}

type EbookStartDetail = {
  ebookId: string;
  chunkIndex?: number;
  pageIndex?: number;
  charIndex: number;
  word?: string;
  source?: "navigation" | "word-dblclick";
};

type EbookOcrTextDetail = {
  ebookId: string;
  pageIndex: number;
  text: string;
};

function fileHintForTrack(t: StoredAudioTrack): string {
  if (t.sourceFileName?.trim()) return t.sourceFileName.trim();
  const ext = t.contentType?.includes("flac")
    ? ".flac"
    : t.contentType?.includes("mpeg") || t.contentType?.includes("mp3")
      ? ".mp3"
      : t.contentType?.includes("mp4")
        ? ".m4a"
        : ".mp3";
  return `${t.name}${ext}`;
}

async function enrichRowWithFileTags(r: LibraryRow): Promise<LibraryRow> {
  if (trackHasPersistedTags(r.track) || r.tagsTooltip || (r.tagArtist && r.tagTitle)) return r;
  if (!(r.track.blob instanceof Blob)) return r;
  try {
    const tags = await extractAudioTagsDetailed(r.track.blob, fileHintForTrack(r.track));
    return {
      ...r,
      tagsTooltip: tags.tooltip,
      tagArtist: tags.artist,
      tagTitle: tags.title,
    };
  } catch {
    return r;
  }
}

function rowWithPersistedTags(r: LibraryRow, t: StoredAudioTrack): LibraryRow {
  return {
    ...r,
    tagsTooltip: t.tagsTooltip ?? r.tagsTooltip,
    tagArtist: t.tagArtist?.trim() ?? r.tagArtist,
    tagTitle: t.tagTitle?.trim() ?? r.tagTitle,
  };
}

function formatResume(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function revokeUrl(url: string) {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* noop */
  }
}

function revokeRow(r: LibraryRow) {
  revokeUrl(r.url);
  if (r.thumbUrl) revokeUrl(r.thumbUrl);
}

function makeLibraryRow(t: StoredAudioTrack): LibraryRow {
  const cover =
    t.coverArt instanceof Blob && t.coverArt.size > 0
      ? t.coverArt
      : null;
  const thumb = cover ? URL.createObjectURL(cover) : null;
  return {
    track: t,
    url: URL.createObjectURL(t.blob),
    thumbUrl: thumb,
    tagsTooltip: t.tagsTooltip ?? null,
    tagArtist: t.tagArtist?.trim() ?? "",
    tagTitle: t.tagTitle?.trim() ?? "",
  };
}

function sortRows(rows: LibraryRow[]): LibraryRow[] {
  return [...rows].sort((a, b) =>
    a.track.name.localeCompare(b.track.name, undefined, { sensitivity: "base" })
  );
}

function splitSpeechText(text: string): string[] {
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

function phraseVariation(text: string): number {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 80); i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return ((Math.abs(hash) % 9) - 4) / 100;
}

function naturalSpeechSegment(text: string, style: EbookTtsStyle): EbookSpeechSegment {
  const source = text.trimStart();
  if (!source) return { text: "", nextOffset: text.length, pauseMs: 0, rateFactor: 1, pitchShift: 0 };
  const leadingTrim = text.length - source.length;
  const dramatic = style === "dramatic";
  const warm = style === "warm";
  const maxLen = dramatic ? 92 : warm ? 128 : 140;
  const minLen = dramatic ? 28 : warm ? 36 : 40;
  const punctuation = /[.!?。！？,;:—-]/g;
  let end = Math.min(source.length, maxLen);
  let pauseMs = dramatic ? 220 : warm ? 180 : 140;
  let rateFactor = dramatic ? 0.94 : warm ? 0.92 : 0.96;
  let pitchShift = 0;
  let match: RegExpExecArray | null;
  while ((match = punctuation.exec(source)) != null) {
    const char = match[0] ?? "";
    const candidate = match.index + char.length;
    if (candidate < minLen && candidate < source.length) continue;
    end = candidate;
    if (/[.!?。！？]/.test(char)) {
      pauseMs = /[?？]/.test(char)
        ? dramatic ? 700 : warm ? 570 : 450
        : /[!！]/.test(char)
          ? dramatic ? 600 : warm ? 460 : 360
          : dramatic ? 520 : warm ? 410 : 300;
      rateFactor = /[!！]/.test(char) ? (dramatic ? 1.02 : warm ? 0.98 : 1) : dramatic ? 0.92 : warm ? 0.91 : 0.95;
      pitchShift = /[?？]/.test(char) ? (dramatic ? 0.05 : 0.02) : /[!！]/.test(char) ? (dramatic ? 0.04 : 0.01) : 0;
    } else {
      pauseMs = dramatic ? 390 : warm ? 300 : 230;
      rateFactor = dramatic ? 0.89 : warm ? 0.9 : 0.94;
      pitchShift = 0;
    }
    break;
  }
  if (end >= maxLen && source.length > maxLen) {
    const wordBreak = source.lastIndexOf(" ", maxLen);
    if (wordBreak >= minLen) end = wordBreak;
  }
  const spoken = source.slice(0, end).trimEnd();
  const lower = spoken.toLowerCase();
  const dialogue = /^[“"']/.test(spoken) || /[,”"']$/.test(spoken);
  if (dialogue) {
    pauseMs += warm ? 80 : 60;
    rateFactor *= dramatic ? 0.96 : 0.98;
  }
  if (dramatic && /\b(whisper|afraid|fear|terrified|angry|cried|shouted|suddenly|never)\b/.test(lower)) {
    pauseMs += 120;
    rateFactor *= /\b(shouted|suddenly|angry)\b/.test(lower) ? 1.04 : 0.88;
    pitchShift += /\b(shouted|suddenly|angry)\b/.test(lower) ? 0.03 : -0.04;
  } else if (warm && /\b(softly|gently|love|smiled|kind|beautiful)\b/.test(lower)) {
    pauseMs += 80;
    rateFactor *= 0.94;
  }
  rateFactor += phraseVariation(spoken);
  const nextOffset = leadingTrim + spoken.length;
  return {
    text: spoken,
    nextOffset,
    pauseMs,
    rateFactor: source.length > maxLen ? Math.min(rateFactor, warm ? 0.93 : 0.96) : rateFactor,
    pitchShift,
  };
}

function naturalSpeechSegmentGroup(text: string, style: EbookTtsStyle, count = 3): EbookSpeechSegment {
  let nextOffset = 0;
  const rates: number[] = [];
  const pitches: number[] = [];
  let pauseMs = 0;
  for (let i = 0; i < count; i++) {
    const remaining = text.slice(nextOffset);
    const segment = naturalSpeechSegment(remaining, style);
    if (!segment.text) break;
    nextOffset += segment.nextOffset;
    rates.push(segment.rateFactor);
    pitches.push(segment.pitchShift);
    pauseMs = segment.pauseMs;
    if (nextOffset >= text.length) break;
  }
  const leadingTrim = text.length - text.trimStart().length;
  const spoken = text.slice(leadingTrim, nextOffset).trimEnd();
  return {
    text: spoken,
    nextOffset: spoken ? nextOffset : text.length,
    pauseMs,
    rateFactor: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 1,
    pitchShift: pitches.length ? pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length : 0,
  };
}

function prepareTextForNeuralTtsPronunciation(text: string): string {
  let out = text
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();

  const replacements: Array<[RegExp, string]> = [
    [/\bMr\./g, "Mister"],
    [/\bMrs\./g, "Misses"],
    [/\bMs\./g, "Miz"],
    [/\bDr\./g, "Doctor"],
    [/\bProf\./g, "Professor"],
    [/\bCapt\./g, "Captain"],
    [/\bLt\./g, "Lieutenant"],
    [/\bCol\./g, "Colonel"],
    [/\bGen\./g, "General"],
    [/\bRev\./g, "Reverend"],
    [/\bHon\./g, "Honorable"],
    [/\bJr\./g, "Junior"],
    [/\bSr\./g, "Senior"],
    [/\bvs\./gi, "versus"],
    [/\betc\./gi, "etcetera"],
    [/\be\.g\./gi, "for example"],
    [/\bi\.e\./gi, "that is"],
    [/\bNo\.\s*(\d+)/g, "number $1"],
    [/\bVol\.\s*(\d+)/gi, "volume $1"],
    [/\bCh\.\s*(\d+)/gi, "chapter $1"],
    [/\bFig\.\s*(\d+)/gi, "figure $1"],
    [/\bSt\.\s+([A-Z][a-z]+)/g, "Saint $1"],
    [/\bAve\./gi, "Avenue"],
    [/\bRd\./gi, "Road"],
    [/\bBlvd\./gi, "Boulevard"],
    [/\bft\./gi, "feet"],
    [/\bin\./gi, "inches"],
    [/\blbs?\./gi, "pounds"],
  ];
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  out = out
    .replace(/&/g, " and ")
    .replace(/@/g, " at ")
    .replace(/#/g, " number ")
    .replace(/(\d+(?:\.\d+)?)\s*%/g, "$1 percent")
    .replace(/\$(\d+(?:[,.]\d+)*)/g, "$1 dollars")
    .replace(/£(\d+(?:[,.]\d+)*)/g, "$1 pounds")
    .replace(/€(\d+(?:[,.]\d+)*)/g, "$1 euros")
    .replace(/\b(\d+(?:\.\d+)?)\s*km\b/gi, "$1 kilometers")
    .replace(/\b(\d+(?:\.\d+)?)\s*cm\b/gi, "$1 centimeters")
    .replace(/\b(\d+(?:\.\d+)?)\s*mm\b/gi, "$1 millimeters")
    .replace(/\b(\d+(?:\.\d+)?)\s*kg\b/gi, "$1 kilograms")
    .replace(/\b(\d+(?:\.\d+)?)\s*mg\b/gi, "$1 milligrams")
    .replace(/\b(\d+(?:\.\d+)?)\s*ml\b/gi, "$1 milliliters")
    .replace(/\b(\d+(?:\.\d+)?)\s*mph\b/gi, "$1 miles per hour")
    .replace(/\b(\d+(?:\.\d+)?)\s*am\b/gi, "$1 A M")
    .replace(/\b(\d+(?:\.\d+)?)\s*pm\b/gi, "$1 P M")
    .replace(/\b([A-Z])\.([A-Z])\.([A-Z])\./g, "$1 $2 $3")
    .replace(/\b([A-Z])\.([A-Z])\./g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  return out || text;
}

function neuralVoiceForGender(voices: NeuralTtsVoice[], gender: EbookVoiceGender): NeuralTtsVoice | null {
  const wanted = gender.toLowerCase();
  const builtInBestId = gender === "male" ? BEST_MALE_NEURAL_VOICE_ID : BEST_NEURAL_VOICE_ID;
  return (
    voices.find((v) => String(v.gender ?? "").toLowerCase() === wanted && v.id.startsWith("piper:")) ??
    voices.find((v) => v.id === builtInBestId) ??
    voices.find((v) => String(v.gender ?? "").toLowerCase() === wanted) ??
    voices.find((v) => v.id.startsWith("piper:")) ??
    voices.find((v) => v.id === BEST_NEURAL_VOICE_ID) ??
    voices[0] ??
    null
  );
}

function estimateSpokenCharIndex(text: string, progress: number): { charIndex: number; charLength?: number } {
  const source = text || "";
  if (!source) return { charIndex: 0 };
  const clamped = Math.min(0.999, Math.max(0, progress));
  const matches = Array.from(source.matchAll(/\S+/g));
  if (!matches.length) return { charIndex: Math.floor(source.length * clamped) };
  const wordIndex = Math.min(matches.length - 1, Math.floor(matches.length * clamped));
  const match = matches[wordIndex];
  return {
    charIndex: match.index ?? Math.floor(source.length * clamped),
    charLength: match[0]?.length,
  };
}

function ebookResumeKey(id: string): string {
  return `${EBOOK_RESUME_PREFIX}${id}`;
}

function loadEbookResumeChunk(id: string): number | null {
  try {
    const n = Number(localStorage.getItem(ebookResumeKey(id)));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

function saveEbookResumeChunk(id: string, chunkIndex: number) {
  try {
    if (chunkIndex <= 0) localStorage.removeItem(ebookResumeKey(id));
    else localStorage.setItem(ebookResumeKey(id), String(Math.floor(chunkIndex)));
  } catch {
    /* noop */
  }
}

function clearEbookResume(id: string) {
  saveEbookResumeChunk(id, 0);
}

function ebookFormatFromFile(file: File): StoredEbook["format"] {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (lower.endsWith(".epub") || /epub/i.test(file.type)) return "epub";
  if (/\.(html|htm|xhtml)$/i.test(lower) || /html/i.test(file.type)) return "html";
  return "text";
}

function fileBodyAsBlob(file: File): Blob {
  const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
  return file.slice(0, file.size, mime);
}

function ebookFromFile(
  file: File,
  title: string,
  text: string,
  pages: string[],
  format = ebookFormatFromFile(file)
): StoredEbook {
  return {
    id: stableLocalAudioIdFromMeta({
      fileName: file.name,
      size: file.size,
      lastModified: file.lastModified,
    }),
    title,
    text,
    pages,
    format,
    blob: fileBodyAsBlob(file),
    size: file.size,
    lastModified: file.lastModified,
    addedAt: Date.now(),
    sourceFileName: file.name,
    contentType: file.type || undefined,
  };
}

function sortEbooks(rows: StoredEbook[]): StoredEbook[] {
  return [...rows].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

function channelFromEbook(row: StoredEbook, startChunk: number): Channel {
  return {
    id: `ebook-lib-${row.id}`,
    name: row.title,
    url: `ebook:${row.id}`,
    ebookId: row.id,
    ebookText: row.text,
    ebookFormat: row.format,
    ebookBlob: row.blob,
    ebookPages: row.pages,
    ebookSourceFileName: row.sourceFileName,
    ebookStartChunk: startChunk,
  };
}

function ebookSpeechPages(row: StoredEbook): string[] {
  const pages = Array.isArray(row.pages) ? row.pages.map((p) => p.trim()).filter(Boolean) : [];
  if (pages.length) return pages;
  return splitSpeechText(row.text);
}

function snapEbookStartOffset(pageText: string, requestedOffset: number, word?: string): number {
  const safeOffset = Math.max(0, Math.min(Math.floor(requestedOffset), pageText.length));
  const token = String(word ?? "").replace(/\s+/g, " ").trim();
  if (!token) return safeOffset;
  const candidates = new Set<string>([token]);
  const stripped = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (stripped) candidates.add(stripped);
  let best = safeOffset;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let from = 0;
    while (from <= pageText.length) {
      const hit = pageText.indexOf(candidate, from);
      if (hit < 0) break;
      const distance = Math.abs(hit - safeOffset);
      if (distance < bestDistance) {
        best = hit;
        bestDistance = distance;
      }
      from = hit + Math.max(candidate.length, 1);
    }
  }
  return bestDistance <= 120 ? best : safeOffset;
}

function mergeIncomingTracks(prev: LibraryRow[], incoming: StoredAudioTrack[]): LibraryRow[] {
  const m = new Map(prev.map((r) => [r.track.id, r]));
  for (const t of incoming) {
    const old = m.get(t.id);
    if (old) revokeRow(old);
    if (!(t.blob instanceof Blob)) continue;
    m.set(t.id, makeLibraryRow(t));
  }
  return sortRows(Array.from(m.values()));
}

function rowsFromIdbTracks(list: StoredAudioTrack[]): LibraryRow[] {
  const out: LibraryRow[] = [];
  for (const t of list) {
    if (!(t.blob instanceof Blob)) continue;
    out.push(makeLibraryRow(t));
  }
  return sortRows(out);
}

function mergeIdbListIntoRows(prev: LibraryRow[], list: StoredAudioTrack[]): LibraryRow[] {
  const fromDb = rowsFromIdbTracks(list);
  const dbIds = new Set(fromDb.map((r) => r.track.id));
  for (const p of prev) {
    if (dbIds.has(p.track.id)) revokeRow(p);
  }
  const kept = prev.filter((p) => !dbIds.has(p.track.id));
  return sortRows([...fromDb, ...kept]);
}

function extensionFromDesktopMime(mime: string): string {
  const m = String(mime ?? "").toLowerCase();
  if (m.includes("flac")) return ".flac";
  if (m.includes("wav")) return ".wav";
  if (m.includes("aac")) return ".aac";
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("webm")) return ".webm";
  if (m.includes("mp4") || m === "audio/mp4") return ".m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  return ".mp3";
}

function normalizePickedPayload(raw: unknown): PickedLocalAudioPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const size = typeof o.size === "number" ? o.size : 0;
  const lastModified = typeof o.lastModified === "number" ? o.lastModified : 0;
  const addedAt = typeof o.addedAt === "number" ? o.addedAt : Date.now();
  const mime = typeof o.mime === "string" ? o.mime : "audio/mpeg";
  let data: ArrayBuffer | null = null;
  if (o.data instanceof ArrayBuffer) data = o.data;
  else if (o.data instanceof Uint8Array) {
    const u = o.data;
    data = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  }
  if (!data || size === 0) return null;

  const fileNameFromMain = typeof o.fileName === "string" ? o.fileName.trim() : "";
  const idFromMain = typeof o.id === "string" ? o.id.trim() : "";
  /** Pre-fileName Electron: path-based id only — keep it so existing IndexedDB lyrics keys still work. */
  const legacyLibDeskId =
    !fileNameFromMain && idFromMain.startsWith("lib-desk-") ? idFromMain : undefined;

  const fileName =
    fileNameFromMain ||
    (name.trim() ? `${name.trim()}${extensionFromDesktopMime(mime)}` : "") ||
    "audio.mp3";

  return {
    fileName,
    legacyLibDeskId,
    name: name.trim() || fileName.replace(/\.[^/.]+$/, "") || "Untitled",
    size,
    lastModified,
    addedAt,
    mime,
    data,
  };
}

export interface LocalAudioPanelHandle {
  clearAll: () => Promise<void>;
}

export interface LocalAudioPanelProps {
  onSelectTrack: (c: Channel) => void;
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
  onLibraryStateChange?: (state: { trackCount: number; busy: boolean }) => void;
  /** IndexedDB sidebar order (`Channel` per row) — used for continuous / shuffle advance on track end. */
  onIndexedLibraryChannelsChange?: (channels: Channel[]) => void;
  audioLibraryShuffle: boolean;
  audioLibraryContinuous: boolean;
  onAudioLibraryShuffleChange: (v: boolean) => void;
  onAudioLibraryContinuousChange: (v: boolean) => void;
  /** Stop any active library track, ebook, or audiobook in the main player when the library is cleared. */
  onLibraryCleared?: () => void;
  /** Stop the main player if this specific IndexedDB audio track is currently active. */
  onLibraryTrackRemoved?: (trackId: string) => void;
}

export const LocalAudioPanel = forwardRef<LocalAudioPanelHandle, LocalAudioPanelProps>(
  function LocalAudioPanel(
    {
      onSelectTrack,
      activeLeftId,
      activeRightId,
      splitView,
      onLibraryStateChange,
      onIndexedLibraryChannelsChange,
      audioLibraryShuffle,
      audioLibraryContinuous,
      onAudioLibraryShuffleChange,
      onAudioLibraryContinuousChange,
      onLibraryCleared,
      onLibraryTrackRemoved,
    },
    ref
  ) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [ebookRows, setEbookRows] = useState<StoredEbook[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ebook, setEbook] = useState<EbookReaderState | null>(null);
  const [ebookNeuralVoiceId, setEbookNeuralVoiceId] = useState(BEST_NEURAL_VOICE_ID);
  const [ebookNeuralVoices, setEbookNeuralVoices] = useState<NeuralTtsVoice[]>([]);
  const [ebookVoiceGender, setEbookVoiceGender] = useState<EbookVoiceGender>(() => loadSavedVoiceGender());
  const [ebookNeuralStatus, setEbookNeuralStatus] = useState("");
  const [ebookSpeechRate, setEbookSpeechRate] = useState(() => loadSavedNumber(EBOOK_NEURAL_RATE_KEY, EBOOK_NEURAL_RATE, 0.65, 1.35));
  const [ebookSpeechPitch, setEbookSpeechPitch] = useState(() => loadSavedNumber(EBOOK_NEURAL_PITCH_KEY, 1, 0.75, 1.25));
  const [ebookSpeechRateDraft, setEbookSpeechRateDraft] = useState(ebookSpeechRate);
  const [ebookSpeechPitchDraft, setEbookSpeechPitchDraft] = useState(ebookSpeechPitch);
  const [ebookVoiceScaleOpen, setEbookVoiceScaleOpen] = useState<"speed" | "pitch" | null>(null);
  const ebookVoiceControlsRef = useRef<HTMLDivElement | null>(null);
  const ebookChunksRef = useRef<string[]>([]);
  const ebookChunkIndexRef = useRef(0);
  const ebookChunkCharOffsetRef = useRef(0);
  const ebookNextTimerRef = useRef<number | null>(null);
  const ebookSpeechRunRef = useRef(0);
  const ebookStatusRef = useRef<EbookReaderState["status"]>("idle");
  const ebookNeuralStatusRef = useRef("");
  const ebookPausedNeedsRestartRef = useRef(false);
  const ebookTtsSettingsRef = useRef("");
  const ebookStopRef = useRef(false);
  const ebookActiveIdRef = useRef<string | null>(null);
  const ebookAudioRef = useRef<HTMLAudioElement | null>(null);
  const ebookAudioSegmentRef = useRef<{ runId: number; index: number; safeCharOffset: number; leadingTrim: number; text: string } | null>(null);
  const ebookAudioResumeRef = useRef<{ index: number; charOffset: number; audioTime: number } | null>(null);
  const ebookNeuralPrefetchKeyRef = useRef("");
  const ebookNeuralPrefetchTimerRef = useRef<number | null>(null);
  const ebookNeuralReadyRef = useRef<Promise<void> | null>(null);
  const ebookTtsPlaybackStartedRef = useRef(false);
  const ebookNavigationStartTimerRef = useRef<number | null>(null);
  const hasDesktopPick = typeof window !== "undefined" && typeof window.iptv?.pickLocalAudioFiles === "function";

  useEffect(() => {
    if (!window.iptv?.listNeuralTtsVoices) {
      setEbookNeuralStatus("Neural TTS is only available in the desktop app.");
      return;
    }
    let cancelled = false;
    void window.iptv
      .listNeuralTtsVoices()
      .then((res) => {
        if (cancelled) return;
        const voices = (Array.isArray(res.voices) ? res.voices : []).filter((v): v is NeuralTtsVoice => {
          return !!v && typeof v.id === "string" && typeof v.name === "string";
        });
        setEbookNeuralVoices(voices);
        const bestVoice = neuralVoiceForGender(voices, ebookVoiceGender);
        if (bestVoice) setEbookNeuralVoiceId(bestVoice.id);
        if (!voices.length) {
          setEbookNeuralStatus("");
          return;
        }
        setEbookNeuralStatus("");
      })
      .catch((ex) => {
        if (cancelled) return;
        setEbookNeuralStatus(ex instanceof Error ? ex.message : String(ex));
      });
    return () => {
      cancelled = true;
    };
  }, [ebookVoiceGender]);

  useEffect(() => {
    saveSetting(EBOOK_NEURAL_RATE_KEY, ebookSpeechRate);
  }, [ebookSpeechRate]);

  useEffect(() => {
    saveSetting(EBOOK_NEURAL_PITCH_KEY, ebookSpeechPitch);
  }, [ebookSpeechPitch]);

  useEffect(() => {
    saveSetting(EBOOK_NEURAL_GENDER_KEY, ebookVoiceGender);
  }, [ebookVoiceGender]);

  const commitEbookRateDraft = useCallback(() => {
    const next = Math.min(1.35, Math.max(0.65, Number(ebookSpeechRateDraft)));
    setEbookSpeechRate((cur) => (Math.abs(cur - next) < 0.001 ? cur : next));
  }, [ebookSpeechRateDraft]);

  const commitEbookPitchDraft = useCallback(() => {
    const next = Math.min(1.25, Math.max(0.75, Number(ebookSpeechPitchDraft)));
    setEbookSpeechPitch((cur) => (Math.abs(cur - next) < 0.001 ? cur : next));
  }, [ebookSpeechPitchDraft]);

  const ebookTtsScaleLocked = ebook?.status === "speaking" || ebook?.status === "preparing";

  useEffect(() => {
    if (ebookTtsScaleLocked) setEbookVoiceScaleOpen(null);
  }, [ebookTtsScaleLocked]);

  useEffect(() => {
    if (!ebookVoiceScaleOpen || ebookTtsScaleLocked) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      const host = ebookVoiceControlsRef.current;
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (host && !host.contains(target)) setEbookVoiceScaleOpen(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setEbookVoiceScaleOpen(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ebookTtsScaleLocked, ebookVoiceScaleOpen]);

  const setEbookNeuralStatusLight = useCallback((next: string) => {
    if (ebookNeuralStatusRef.current === next) return;
    ebookNeuralStatusRef.current = next;
    setEbookNeuralStatus(next);
  }, []);

  const ensureNeuralTtsReady = useCallback(async (voiceId: string) => {
    if (voiceId.startsWith("piper:")) return;
    if (!window.iptv?.warmupNeuralTts) return;
    if (!ebookNeuralReadyRef.current) {
      setEbookNeuralStatusLight("Preparing neural voice (first use may take a minute)...");
      ebookNeuralReadyRef.current = window.iptv
        .warmupNeuralTts()
        .then(() => {
          setEbookNeuralStatusLight("Neural voice ready.");
        })
        .catch((ex) => {
          ebookNeuralReadyRef.current = null;
          throw ex;
        });
    }
    await ebookNeuralReadyRef.current;
  }, [setEbookNeuralStatusLight]);

  useEffect(() => {
    ebookStatusRef.current = ebook?.status ?? "idle";
  }, [ebook?.status]);

  useEffect(() => {
    ebookNeuralStatusRef.current = ebookNeuralStatus;
  }, [ebookNeuralStatus]);

  const stopEbookSpeech = useCallback(() => {
    ebookStopRef.current = true;
    ebookSpeechRunRef.current += 1;
    ebookPausedNeedsRestartRef.current = false;
    ebookTtsPlaybackStartedRef.current = false;
    ebookAudioResumeRef.current = null;
    ebookAudioSegmentRef.current = null;
    ebookNeuralPrefetchKeyRef.current = "";
    if (ebookNextTimerRef.current != null) {
      window.clearTimeout(ebookNextTimerRef.current);
      ebookNextTimerRef.current = null;
    }
    if (ebookNeuralPrefetchTimerRef.current != null) {
      window.clearTimeout(ebookNeuralPrefetchTimerRef.current);
      ebookNeuralPrefetchTimerRef.current = null;
    }
    if (ebookNavigationStartTimerRef.current != null) {
      window.clearTimeout(ebookNavigationStartTimerRef.current);
      ebookNavigationStartTimerRef.current = null;
    }
    if (ebookAudioRef.current) {
      ebookAudioRef.current.pause();
      ebookAudioRef.current.removeAttribute("src");
      ebookAudioRef.current.load();
    }
    void window.iptv?.cancelNeuralTts?.();
    dispatchEbookTtsActive(ebookActiveIdRef.current, false);
    setEbook((cur) => (cur ? { ...cur, status: "idle" } : cur));
  }, []);

  const speakEbookChunk = useCallback((index: number, charOffset = 0) => {
    const canUseNeuralTts = typeof window !== "undefined" && !!window.iptv?.synthesizeNeuralTts;
    if (!canUseNeuralTts) {
      setErr("Neural TTS is only available in the Player desktop app.");
      return;
    }
    const chunks = ebookChunksRef.current;
    if (index < 0 || index >= chunks.length) {
      ebookChunkIndexRef.current = chunks.length;
      if (ebookActiveIdRef.current) clearEbookResume(ebookActiveIdRef.current);
      dispatchEbookTtsActive(ebookActiveIdRef.current, false);
      setEbook((cur) => (cur ? { ...cur, status: "idle", chunkIndex: chunks.length, chunkCount: chunks.length } : cur));
      return;
    }
    ebookStopRef.current = false;
    ebookSpeechRunRef.current += 1;
    const runId = ebookSpeechRunRef.current;
    if (ebookNextTimerRef.current != null) {
      window.clearTimeout(ebookNextTimerRef.current);
      ebookNextTimerRef.current = null;
    }
    ebookChunkIndexRef.current = index;
    const safeCharOffset = Math.max(0, Math.min(Math.floor(charOffset), chunks[index]?.length ?? 0));
    ebookChunkCharOffsetRef.current = safeCharOffset;
    if (ebookActiveIdRef.current) saveEbookResumeChunk(ebookActiveIdRef.current, index);
    const remainingText = (chunks[index] ?? "").slice(safeCharOffset);
    const neuralSegmentStyle = EBOOK_NEURAL_STYLE;
    const naturalSegment = naturalSpeechSegmentGroup(remainingText, neuralSegmentStyle, EBOOK_TTS_SEGMENT_GROUP_COUNT);
    const textToSpeak = naturalSegment?.text ?? remainingText.trimStart();
    if (!textToSpeak) {
      speakEbookChunk(index + 1);
      return;
    }
    const leadingTrim = remainingText.length - remainingText.trimStart().length;
    const nextCharOffset =
      naturalSegment != null ? safeCharOffset + naturalSegment.nextOffset : (chunks[index] ?? "").length;
    const synthRate = Math.min(1.35, Math.max(0.65, (naturalSegment?.rateFactor ?? 1) / ebookSpeechPitch));
    if (canUseNeuralTts) {
      const synthesizeNeuralSegment = async (text: string, speed = synthRate, prefetch = false) => {
        const ttsText = prepareTextForNeuralTtsPronunciation(text);
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const res = await window.iptv!.synthesizeNeuralTts({
            text: ttsText,
            voice: ebookNeuralVoiceId,
            speed: Math.min(1.35, Math.max(0.65, speed)),
            style: neuralSegmentStyle,
            prefetch,
          });
          if (!res.skipped) return res;
          if (prefetch || ebookSpeechRunRef.current !== runId || ebookStopRef.current) return res;
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
        return window.iptv!.synthesizeNeuralTts({
          text: ttsText,
          voice: ebookNeuralVoiceId,
          speed: Math.min(1.35, Math.max(0.65, speed)),
          style: neuralSegmentStyle,
          prefetch: false,
        });
      };
      const prefetchNeuralSegment = (nextIndex: number, nextOffset = 0) => {
        if (!EBOOK_TTS_PREFETCH_ENABLED) return;
        if (!ebookTtsPlaybackStartedRef.current) return;
        if (document.hidden) return;
        const nextText = chunks[nextIndex];
        if (!nextText || nextIndex < 0 || nextIndex >= chunks.length) return;
        const nextRemaining = nextText.slice(Math.max(0, Math.min(nextOffset, nextText.length)));
        const nextSegment = naturalSpeechSegmentGroup(nextRemaining, neuralSegmentStyle, EBOOK_TTS_SEGMENT_GROUP_COUNT);
        if (!nextSegment.text) return;
        const nextSynthRate = Math.min(1.35, Math.max(0.65, nextSegment.rateFactor / ebookSpeechPitch));
        const nextTtsText = prepareTextForNeuralTtsPronunciation(nextSegment.text);
        const prefetchKey = `${nextIndex}:${nextOffset}:${ebookNeuralVoiceId}:${ebookSpeechRate}:${ebookSpeechPitch}:${neuralSegmentStyle}:${nextTtsText}`;
        if (ebookNeuralPrefetchKeyRef.current === prefetchKey) return;
        ebookNeuralPrefetchKeyRef.current = prefetchKey;
        if (ebookSpeechRunRef.current !== runId || ebookStopRef.current) return;
        void synthesizeNeuralSegment(nextSegment.text, nextSynthRate, true).finally(() => {
          if (ebookNeuralPrefetchKeyRef.current === prefetchKey) ebookNeuralPrefetchKeyRef.current = "";
        }).catch(() => {
          /* Prefetch is best-effort; foreground playback reports real errors. */
        });
      };
      const prefetchUpcomingSegment = () => {
        if (naturalSegment != null && nextCharOffset < (chunks[index]?.length ?? 0)) {
          prefetchNeuralSegment(index, nextCharOffset);
          return;
        }
        prefetchNeuralSegment(index + 1, 0);
      };
      const schedulePrefetchUpcomingSegment = () => {
        if (ebookNeuralPrefetchTimerRef.current != null) return;
        ebookNeuralPrefetchTimerRef.current = window.setTimeout(() => {
          ebookNeuralPrefetchTimerRef.current = null;
          if (ebookSpeechRunRef.current !== runId || ebookStopRef.current) return;
          prefetchUpcomingSegment();
        }, 120);
      };
      const scheduleAfterSegment = (fn: () => void) => {
        if (ebookNextTimerRef.current != null) window.clearTimeout(ebookNextTimerRef.current);
        ebookNextTimerRef.current = window.setTimeout(() => {
          ebookNextTimerRef.current = null;
          fn();
        }, 0);
      };
      const runAfterSegment = () => {
        if (ebookSpeechRunRef.current !== runId) return;
        if (ebookStopRef.current) return;
        if (ebookChunkIndexRef.current !== index) return;
        if (naturalSegment != null && nextCharOffset < (chunks[index]?.length ?? 0)) {
          ebookChunkCharOffsetRef.current = nextCharOffset;
          scheduleAfterSegment(() => speakEbookChunk(index, nextCharOffset));
          return;
        }
        if (ebookActiveIdRef.current) saveEbookResumeChunk(ebookActiveIdRef.current, index + 1);
        ebookChunkCharOffsetRef.current = 0;
        scheduleAfterSegment(() => speakEbookChunk(index + 1));
      };
      setEbookNeuralStatusLight(textToSpeak.length > 150 ? "Generating neural voice..." : "Starting neural voice...");
      setEbook((cur) => (cur ? { ...cur, status: "preparing" } : cur));
      void (async () => {
        try {
          await ensureNeuralTtsReady(ebookNeuralVoiceId);
          if (ebookSpeechRunRef.current !== runId || ebookStopRef.current) return;
          const res = await synthesizeNeuralSegment(textToSpeak);
          if (ebookSpeechRunRef.current !== runId) return;
          if (ebookStopRef.current || res.canceled) {
            dispatchEbookTtsActive(ebookActiveIdRef.current, false);
            setEbook((cur) => (cur ? { ...cur, status: "idle" } : cur));
            return;
          }
          if (res.skipped) {
            throw new Error("Neural voice engine is busy. Try again in a moment.");
          }
          if (!res.ok || !res.url) throw new Error("Neural TTS did not return audio.");
          const audio = ebookAudioRef.current ?? new Audio();
          ebookAudioRef.current = audio;
          audio.pause();
          audio.src = res.url;
          audio.playbackRate = Math.min(1.75, Math.max(0.5, ebookSpeechRate * ebookSpeechPitch));
          const pitchedAudio = audio as HTMLAudioElement & {
            preservesPitch?: boolean;
            mozPreservesPitch?: boolean;
            webkitPreservesPitch?: boolean;
          };
          pitchedAudio.preservesPitch = false;
          pitchedAudio.mozPreservesPitch = false;
          pitchedAudio.webkitPreservesPitch = false;
          audio.volume = EBOOK_NEURAL_VOLUME;
          ebookAudioSegmentRef.current = { runId, index, safeCharOffset, leadingTrim, text: textToSpeak };
          const highlightStart = safeCharOffset + leadingTrim;
          const highlightLength = Math.max(1, textToSpeak.length);
          let prefetchStarted = false;
          let lastProgressUpdateAt = 0;
          if (ebookActiveIdRef.current != null) {
            dispatchEbookSpeechBoundary({
              ebookId: ebookActiveIdRef.current,
              chunkIndex: index,
              charIndex: highlightStart,
              charLength: highlightLength,
            });
          }
          audio.ontimeupdate = () => {
            const segment = ebookAudioSegmentRef.current;
            if (!segment || segment.runId !== runId || ebookActiveIdRef.current == null) return;
            const now = performance.now();
            if (now - lastProgressUpdateAt < EBOOK_TTS_PROGRESS_UPDATE_MS) return;
            lastProgressUpdateAt = now;
            const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (res.durationMs ?? 0) / 1000;
            const progress = duration > 0 ? audio.currentTime / duration : 0;
            const estimate = estimateSpokenCharIndex(segment.text, progress);
            ebookChunkCharOffsetRef.current = segment.safeCharOffset + segment.leadingTrim + estimate.charIndex;
            if (
              !prefetchStarted &&
              ebookTtsPlaybackStartedRef.current &&
              EBOOK_TTS_PREFETCH_ENABLED &&
              progress >= EBOOK_TTS_PREFETCH_AFTER_PROGRESS
            ) {
              prefetchStarted = true;
              schedulePrefetchUpcomingSegment();
            }
          };
          audio.onended = runAfterSegment;
          audio.onerror = () => {
            if (ebookSpeechRunRef.current !== runId) return;
            dispatchEbookTtsActive(ebookActiveIdRef.current, false);
            setEbook((cur) => (cur ? { ...cur, status: "idle" } : cur));
            setErr("Neural TTS audio could not be played.");
          };
          if (ebookAudioResumeRef.current?.index === index) {
            audio.currentTime = Math.max(0, ebookAudioResumeRef.current.audioTime);
            ebookAudioResumeRef.current = null;
          }
          dispatchEbookTtsActive(ebookActiveIdRef.current, true);
          try {
            await audio.play();
          } catch (playError) {
            dispatchEbookTtsActive(ebookActiveIdRef.current, false);
            if (isInterruptedMediaPlayError(playError) || ebookSpeechRunRef.current !== runId || ebookStopRef.current) {
              return;
            }
            throw playError;
          }
          if (ebookSpeechRunRef.current !== runId) return;
          ebookTtsPlaybackStartedRef.current = true;
          setEbookNeuralStatusLight(res.cached ? "Playing cached neural voice." : "Playing neural voice.");
          setEbook((cur) => (cur ? { ...cur, status: "speaking", chunkIndex: index + 1, chunkCount: chunks.length } : cur));
          window.setTimeout(() => {
            if (ebookSpeechRunRef.current !== runId || ebookStopRef.current) return;
            schedulePrefetchUpcomingSegment();
          }, EBOOK_TTS_PREFETCH_DELAY_AFTER_PLAY_MS);
        } catch (ex) {
          if (ebookSpeechRunRef.current !== runId) return;
          const message = ex instanceof Error ? ex.message : String(ex);
          dispatchEbookTtsActive(ebookActiveIdRef.current, false);
          setEbookNeuralStatusLight(`Neural TTS failed: ${message}`);
          setErr(message);
          setEbook((cur) => (cur ? { ...cur, status: "idle" } : cur));
        }
      })();
      return;
    }
  }, [ebookNeuralVoiceId, ebookSpeechPitch, ebookSpeechRate, ensureNeuralTtsReady, setEbookNeuralStatusLight]);

  const pauseEbook = useCallback(() => {
    if (!ebookAudioRef.current) return;
    ebookAudioRef.current.pause();
    ebookAudioResumeRef.current = {
      index: ebookChunkIndexRef.current,
      charOffset: ebookChunkCharOffsetRef.current,
      audioTime: ebookAudioRef.current.currentTime,
    };
    dispatchEbookTtsActive(ebookActiveIdRef.current, false);
    setEbook((cur) => (cur ? { ...cur, status: "paused" } : cur));
  }, []);

  const resumePausedEbook = useCallback(
    (ev?: React.MouseEvent) => {
      ev?.preventDefault();
      ev?.stopPropagation();
      if (ebookPausedNeedsRestartRef.current) {
        ebookPausedNeedsRestartRef.current = false;
        speakEbookChunk(ebookChunkIndexRef.current, ebookChunkCharOffsetRef.current);
        return;
      }
      if (ebookAudioRef.current) {
        dispatchEbookTtsActive(ebookActiveIdRef.current, true);
        void ebookAudioRef.current.play().catch((playError: unknown) => {
          dispatchEbookTtsActive(ebookActiveIdRef.current, false);
          if (isInterruptedMediaPlayError(playError)) return;
          setErr(playError instanceof Error ? playError.message : String(playError));
        });
        setEbook((cur) => (cur ? { ...cur, status: "speaking" } : cur));
        return;
      }
    },
    [speakEbookChunk]
  );

  const pauseEbookForAudioSelection = useCallback(() => {
    if (ebookStatusRef.current !== "speaking") return;
    pauseEbook();
  }, [pauseEbook]);

  useEffect(
    () => () => {
      ebookStopRef.current = true;
      ebookSpeechRunRef.current += 1;
      ebookNeuralPrefetchKeyRef.current = "";
      if (ebookNextTimerRef.current != null) {
        window.clearTimeout(ebookNextTimerRef.current);
        ebookNextTimerRef.current = null;
      }
      if (ebookNeuralPrefetchTimerRef.current != null) {
        window.clearTimeout(ebookNeuralPrefetchTimerRef.current);
        ebookNeuralPrefetchTimerRef.current = null;
      }
      if (ebookNavigationStartTimerRef.current != null) {
        window.clearTimeout(ebookNavigationStartTimerRef.current);
        ebookNavigationStartTimerRef.current = null;
      }
      if (ebookAudioRef.current) {
        ebookAudioRef.current.pause();
        ebookAudioRef.current.removeAttribute("src");
        ebookAudioRef.current.load();
      }
      void window.iptv?.cancelNeuralTts?.();
      dispatchEbookTtsActive(ebookActiveIdRef.current, false);
    },
    []
  );

  useEffect(() => {
    const signature = `${ebookNeuralVoiceId}\u0000${ebookSpeechRate}\u0000${ebookSpeechPitch}`;
    const prev = ebookTtsSettingsRef.current;
    ebookTtsSettingsRef.current = signature;
    if (!prev || prev === signature) return;
    const status = ebookStatusRef.current;
    if (status === "speaking") {
      speakEbookChunk(ebookChunkIndexRef.current, ebookChunkCharOffsetRef.current);
    } else if (status === "paused") {
      ebookPausedNeedsRestartRef.current = true;
      ebookSpeechRunRef.current += 1;
        ebookNeuralPrefetchKeyRef.current = "";
        if (ebookNeuralPrefetchTimerRef.current != null) {
          window.clearTimeout(ebookNeuralPrefetchTimerRef.current);
          ebookNeuralPrefetchTimerRef.current = null;
        }
      if (ebookAudioRef.current) ebookAudioRef.current.pause();
      void window.iptv?.cancelNeuralTts?.();
        dispatchEbookTtsActive(ebookActiveIdRef.current, false);
    }
  }, [ebookNeuralVoiceId, ebookSpeechPitch, ebookSpeechRate, speakEbookChunk]);

  useEffect(() => {
    onIndexedLibraryChannelsChange?.(rows.map((r) => channelFromLibraryTrack(r.track, r.url)));
  }, [rows, onIndexedLibraryChannelsChange]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(
    () => () => {
      for (const r of rowsRef.current) revokeRow(r);
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    void (async () => {
      try {
        const [list, ebooks] = await Promise.all([listAudioLibraryTracks(), listEbookLibraryItems()]);
        if (cancelled) return;
        let workingRows: LibraryRow[] = [];
        setRows((prev) => {
          workingRows = mergeIdbListIntoRows(prev, list);
          return workingRows;
        });
        setEbookRows(sortEbooks(ebooks));

        const tagUpdates = new Map<string, LibraryRow>();
        for (const t of list) {
          if (cancelled) return;
          const row = workingRows.find((r) => r.track.id === t.id);
          if (!row) continue;

          let currentRow = rowWithPersistedTags(row, t);
          if (!trackHasPersistedTags(t)) {
            currentRow = await enrichRowWithFileTags(currentRow);
            try {
              await persistStoredTrack({
                ...t,
                tagArtist: currentRow.tagArtist,
                tagTitle: currentRow.tagTitle,
                tagsTooltip: currentRow.tagsTooltip,
                tagsEnriched: true,
              });
            } catch {
              /* keep in-memory tags */
            }
            tagUpdates.set(t.id, currentRow);
          }

          if (t.coverArt instanceof Blob && t.coverArt.size > 0) continue;
          const next = await enrichStoredTrackWithCoverArt(t);
          const now = next.coverArt instanceof Blob && next.coverArt.size > 0;
          if (!now) continue;
          try {
            await persistStoredTrack(next);
          } catch {
            continue;
          }
          if (cancelled) return;
          const prior = tagUpdates.get(next.id) ?? workingRows.find((r) => r.track.id === next.id);
          if (prior) revokeRow(prior);
          const fresh = makeLibraryRow(next);
          tagUpdates.set(next.id, {
            ...fresh,
            tagsTooltip: prior?.tagsTooltip ?? fresh.tagsTooltip,
            tagArtist: prior?.tagArtist ?? fresh.tagArtist,
            tagTitle: prior?.tagTitle ?? fresh.tagTitle,
          });
        }

        if (!cancelled && tagUpdates.size > 0) {
          setRows((prev) =>
            prev.map((r) => {
              const updated = tagUpdates.get(r.track.id);
              return updated ?? r;
            })
          );
        }
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enrichTagsForRows = async (toTag: LibraryRow[]) => {
    const updates = new Map<string, LibraryRow>();
    for (const row of toTag) {
      if (trackHasPersistedTags(row.track) || row.tagsTooltip || (row.tagArtist && row.tagTitle)) continue;
      const tagged = await enrichRowWithFileTags(row);
      updates.set(tagged.track.id, tagged);
      try {
        await persistStoredTrack({
          ...row.track,
          tagArtist: tagged.tagArtist,
          tagTitle: tagged.tagTitle,
          tagsTooltip: tagged.tagsTooltip,
          tagsEnriched: true,
        });
      } catch {
        /* keep in-memory tags */
      }
    }
    if (!updates.size) return;
    setRows((prev) => prev.map((r) => updates.get(r.track.id) ?? r));
  };


  const importAudioLibraryFiles = useCallback(async (files: File[]) => {
    const valid = files.filter((file) => file.size > 0);
    if (!valid.length) return [];
    const enrichedList: StoredAudioTrack[] = [];
    for (const file of valid) {
      const enriched = await enrichStoredTrackWithCoverArt(fileToStoredTrack(file));
      await persistStoredTrack(enriched);
      enrichedList.push(enriched);
    }
    if (!enrichedList.length) return [];
    const addedIds = new Set(enrichedList.map((t) => t.id));
    setRows((prev) => {
      const merged = mergeIncomingTracks(prev, enrichedList);
      void enrichTagsForRows(merged.filter((r) => addedIds.has(r.track.id)));
      return merged;
    });
    return enrichedList;
  }, []);

  const importDesktopAudioPicks = useCallback(async (payloads: PickedLocalAudioPayload[]) => {
    const valid = payloads
      .map((item) => normalizePickedPayload(item))
      .filter((norm): norm is PickedLocalAudioPayload => norm != null);
    if (!valid.length) return [];
    const enrichedList: StoredAudioTrack[] = [];
    for (const norm of valid) {
      const enriched = await enrichStoredTrackWithCoverArt(trackFromDesktopPick(norm));
      await persistStoredTrack(enriched);
      enrichedList.push(enriched);
    }
    if (!enrichedList.length) return [];
    const addedIds = new Set(enrichedList.map((t) => t.id));
    setRows((prev) => {
      const merged = mergeIncomingTracks(prev, enrichedList);
      void enrichTagsForRows(merged.filter((r) => addedIds.has(r.track.id)));
      return merged;
    });
    return enrichedList;
  }, []);

  const importEbookLibraryFile = useCallback(
    async (file: File, options?: { openInReader?: boolean }) => {
      stopEbookSpeech();
      const format = ebookFormatFromFile(file);
      let result: Awaited<ReturnType<typeof extractEbookText>> | null = null;
      try {
        result = await extractEbookText(file);
      } catch (ex) {
        if (format !== "pdf") throw ex;
        result = null;
      }
      const title = result?.title ?? file.name.replace(/\.[^/.]+$/, "") ?? file.name ?? "PDF";
      const isPdf = (result?.format ?? format) === "pdf";
      const pages = result?.pages?.length ? result.pages : isPdf ? ["Open a page to load PDF text for read-aloud."] : [result?.text ?? ""];
      const text = result?.text?.trim() || (isPdf ? pages[0] ?? "" : pages.join("\n\n"));
      const chunks = [...pages];
      if (!chunks.length) chunks.push("");
      const row = ebookFromFile(file, title, text, pages, result?.format ?? format);
      await persistEbookLibraryItem(row);
      setEbookRows((prev) => sortEbooks([row, ...prev.filter((r) => r.id !== row.id)]));
      clearEbookResume(row.id);
      if (options?.openInReader) {
        ebookChunksRef.current = chunks;
        ebookChunkIndexRef.current = 0;
        ebookActiveIdRef.current = row.id;
        setEbook({
          id: row.id,
          title: row.title,
          text: row.text,
          status: "idle",
          chunkIndex: 0,
          chunkCount: chunks.length,
        });
        onSelectTrack(channelFromEbook(row, 0));
      }
      return row;
    },
    [onSelectTrack, stopEbookSpeech]
  );

  const importLibraryFromFiles = useCallback(
    async (files: File[]) => {
      const sorted = [...files].sort((a, b) => {
        const ra = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name;
        const rb = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name;
        return ra.localeCompare(rb, undefined, { sensitivity: "base" });
      });
      const skipped: string[] = [];
      const audioFiles: File[] = [];
      const ebookFiles: File[] = [];
      for (const file of sorted) {
        if (!file.size) continue;
        if (isEbookLibraryFile(file.name, file.type)) ebookFiles.push(file);
        else if (isAudioLibraryFile(file.name, file.type)) audioFiles.push(file);
        else skipped.push(file.name);
      }
      const audioTracks = await importAudioLibraryFiles(audioFiles);
      const audioAdded = audioTracks.length;
      const openSingleEbook =
        ebookFiles.length === 1 &&
        audioAdded === 0 &&
        sorted.length === 1 &&
        shouldAutoOpenEbookOnImport(ebookFiles[0]!.name, ebookFiles[0]!.type);
      let ebookAdded = 0;
      for (const file of ebookFiles) {
        await importEbookLibraryFile(file, { openInReader: openSingleEbook });
        ebookAdded += 1;
      }
      return { audioAdded, ebookAdded, skipped, total: sorted.length };
    },
    [importAudioLibraryFiles, importEbookLibraryFile]
  );

  const importLibraryFromDesktopPicks = useCallback(
    async (picked: unknown[]) => {
      const skipped: string[] = [];
      const audioItems: PickedLocalAudioPayload[] = [];
      const ebookItems: PickedLocalAudioPayload[] = [];
      for (const item of picked) {
        const norm = normalizePickedPayload(item);
        if (!norm) continue;
        const fileName = pickedLibraryFileName(norm);
        if (isEbookLibraryFile(fileName, norm.mime)) ebookItems.push(norm);
        else if (isAudioLibraryFile(fileName, norm.mime)) audioItems.push(norm);
        else skipped.push(fileName);
      }
      const audioTracks = await importDesktopAudioPicks(audioItems);
      const audioAdded = audioTracks.length;
      const openSingleEbook =
        ebookItems.length === 1 &&
        audioAdded === 0 &&
        picked.length === 1 &&
        shouldAutoOpenEbookOnImport(pickedLibraryFileName(ebookItems[0]!), ebookItems[0]!.mime);
      let ebookAdded = 0;
      for (const item of ebookItems) {
        await importEbookLibraryFile(desktopPickToFile(item), { openInReader: openSingleEbook });
        ebookAdded += 1;
      }
      return { audioAdded, ebookAdded, skipped, total: picked.length };
    },
    [importDesktopAudioPicks, importEbookLibraryFile]
  );

  const onPickLibraryFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    e.target.value = "";
    if (!fileList?.length) return;
    const files = Array.from(fileList).filter((file) => file.size > 0);
    if (!files.length) {
      setErr("No files were imported (empty selection or zero-byte files).");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { audioAdded, ebookAdded, skipped } = await importLibraryFromFiles(files);
      if (audioAdded === 0 && ebookAdded === 0) {
        setErr(
          skipped.length
            ? `Unsupported file type(s): ${skipped.slice(0, 4).join(", ")}`
            : "No files were imported (empty selection or zero-byte files)."
        );
      } else if (skipped.length) {
        setErr(`Added ${audioAdded + ebookAdded} file(s). Skipped unsupported: ${skipped.slice(0, 4).join(", ")}`);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onAddDesktop = async () => {
    if (!window.iptv?.pickLocalAudioFiles) return;
    setBusy(true);
    setErr(null);
    try {
      const picked = await window.iptv.pickLocalAudioFiles();
      if (!picked.length) return;
      const { audioAdded, ebookAdded, skipped } = await importLibraryFromDesktopPicks(picked);
      if (audioAdded === 0 && ebookAdded === 0) {
        setErr(
          skipped.length
            ? `Unsupported file type(s): ${skipped.slice(0, 4).join(", ")}`
            : "No files were added (empty folder, unreadable paths, or zero-byte files)."
        );
      } else if (skipped.length) {
        setErr(`Added ${audioAdded + ebookAdded} file(s). Skipped unsupported: ${skipped.slice(0, 4).join(", ")}`);
      }
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onClearAll = useCallback(async () => {
    const total = rows.length + ebookRows.length;
    if (total === 0) return;
    const ok = window.confirm(
      `Remove all ${total} file${total === 1 ? "" : "s"} from the audio library? This cannot be undone.`
    );
    if (!ok) return;
    stopEbookSpeech();
    ebookActiveIdRef.current = null;
    dispatchLibraryCleared();
    onLibraryCleared?.();
    setLibraryPlaybackState(null);
    setBusy(true);
    setErr(null);
    try {
      const ids = rows.map((r) => r.track.id);
      const ebookIds = ebookRows.map((r) => r.id);
      await clearAudioLibrary();
      for (const r of rows) revokeRow(r);
      for (const id of ids) clearAudioResume(id);
      for (const id of ebookIds) clearEbookResume(id);
      setRows([]);
      setEbookRows([]);
      setEbook(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }, [ebookRows, onLibraryCleared, rows, stopEbookSpeech]);

  useImperativeHandle(ref, () => ({ clearAll: onClearAll }), [onClearAll]);

  useEffect(() => {
    onLibraryStateChange?.({ trackCount: rows.length + ebookRows.length, busy });
  }, [rows.length, ebookRows.length, busy, onLibraryStateChange]);

  const onRemove = async (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      await removeAudioLibraryTrack(id);
      clearAudioResume(id);
      onLibraryTrackRemoved?.(id);
      setLibraryPlaybackState((cur) => (cur?.trackId === id ? null : cur));
      setRows((prev) => {
        const hit = prev.find((r) => r.track.id === id);
        if (hit) revokeRow(hit);
        return prev.filter((r) => r.track.id !== id);
      });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onRemoveEbook = async (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      await removeEbookLibraryItem(id);
      clearEbookResume(id);
      if (ebookActiveIdRef.current === id) {
        stopEbookSpeech();
        ebookActiveIdRef.current = null;
        setEbook(null);
      }
      setEbookRows((prev) => prev.filter((r) => r.id !== id));
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const [resumeTick, setResumeTick] = useState(0);
  const [libraryPlaybackState, setLibraryPlaybackState] = useState<{ trackId: string; paused: boolean } | null>(null);
  const bumpResumeHints = useCallback(() => setResumeTick((n) => n + 1), []);

  useEffect(() => {
    const onFocus = () => bumpResumeHints();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [bumpResumeHints]);

  useEffect(() => {
    const onPlaybackState = (ev: Event) => {
      const detail = (ev as CustomEvent<{ trackId?: string; paused?: boolean }>).detail;
      if (!detail?.trackId || typeof detail.paused !== "boolean") return;
      setLibraryPlaybackState({ trackId: detail.trackId, paused: detail.paused });
      bumpResumeHints();
    };
    window.addEventListener(LIBRARY_AUDIO_STATE_EVENT, onPlaybackState);
    return () => window.removeEventListener(LIBRARY_AUDIO_STATE_EVENT, onPlaybackState);
  }, [bumpResumeHints]);

  const playRow = useCallback(
    (r: LibraryRow) => {
      pauseEbookForAudioSelection();
      onSelectTrack(channelFromLibraryTrack(r.track, r.url));
      bumpResumeHints();
    },
    [onSelectTrack, bumpResumeHints, pauseEbookForAudioSelection]
  );

  const playFromStart = useCallback(
    (r: LibraryRow, ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      pauseEbookForAudioSelection();
      clearAudioResume(r.track.id);
      bumpResumeHints();
      onSelectTrack(channelFromLibraryTrack(r.track, r.url, { restartNonce: Date.now() }));
    },
    [onSelectTrack, bumpResumeHints, pauseEbookForAudioSelection]
  );

  const toggleAudioTrackPlayback = useCallback(
    (r: LibraryRow, isActive: boolean, ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      pauseEbookForAudioSelection();
      if (isActive) {
        window.dispatchEvent(new CustomEvent(LIBRARY_AUDIO_TOGGLE_EVENT, { detail: { trackId: r.track.id } }));
        return;
      }
      bumpResumeHints();
      onSelectTrack(channelFromLibraryTrack(r.track, r.url));
    },
    [bumpResumeHints, onSelectTrack, pauseEbookForAudioSelection]
  );

  const loadEbookInReader = useCallback((row: StoredEbook, startChunk: number, startChar = 0, shouldSpeak = false) => {
    stopEbookSpeech();
    const chunks = ebookSpeechPages(row);
    if (!chunks.length) {
      setErr("No readable text was found in that ebook.");
      return;
    }
    const safeStart = Math.max(0, Math.min(startChunk, chunks.length - 1));
    const safeChar = Math.max(0, Math.min(Math.floor(startChar), chunks[safeStart]?.length ?? 0));
    onSelectTrack(channelFromEbook(row, safeStart));
    ebookChunksRef.current = chunks;
    ebookChunkIndexRef.current = safeStart;
    ebookChunkCharOffsetRef.current = safeChar;
    ebookActiveIdRef.current = row.id;
    setEbook({
      id: row.id,
      title: row.title,
      text: row.text,
      status: "idle",
      chunkIndex: safeStart,
      chunkCount: chunks.length,
    });
    if (shouldSpeak) speakEbookChunk(safeStart, safeChar);
  }, [onSelectTrack, speakEbookChunk, stopEbookSpeech]);

  const openEbookForReading = useCallback(
    (row: StoredEbook, ev?: React.MouseEvent) => {
      ev?.preventDefault();
      ev?.stopPropagation();
      bumpResumeHints();
      loadEbookInReader(row, loadEbookResumeChunk(row.id) ?? 0, 0, false);
    },
    [bumpResumeHints, loadEbookInReader]
  );

  useEffect(() => {
    const onOcrText = (ev: Event) => {
      const detail = (ev as CustomEvent<EbookOcrTextDetail>).detail;
      if (!detail?.ebookId || typeof detail.text !== "string") return;
      const pageIndex = Math.max(0, Math.floor(detail.pageIndex));
      const text = detail.text.trim();
      if (!text) return;
      setEbookRows((prev) => {
        const next = prev.map((row) => {
          if (row.id !== detail.ebookId) return row;
          const pages = [...(row.pages?.length ? row.pages : [row.text])];
          pages[pageIndex] = text;
          const mergedText = pages.filter(Boolean).join("\n\n");
          const updated = { ...row, pages, text: mergedText };
          void persistEbookLibraryItem(updated);
          if (ebookActiveIdRef.current === row.id) {
            ebookChunksRef.current = pages;
            setEbook((cur) => (cur ? { ...cur, text: mergedText, chunkCount: pages.length } : cur));
          }
          return updated;
        });
        return sortEbooks(next);
      });
    };
    window.addEventListener(EBOOK_OCR_TEXT_EVENT, onOcrText);
    return () => window.removeEventListener(EBOOK_OCR_TEXT_EVENT, onOcrText);
  }, []);

  useEffect(() => {
    const onStartAt = (ev: Event) => {
      const detail = (ev as CustomEvent<EbookStartDetail>).detail;
      if (!detail?.ebookId) return;
      if (ebookStatusRef.current === "paused" && ebookActiveIdRef.current === detail.ebookId && detail.source !== "word-dblclick") return;
      if (detail.source === "navigation" && (ebookStatusRef.current !== "speaking" || ebookActiveIdRef.current !== detail.ebookId)) return;
      const row = ebookRows.find((item) => item.id === detail.ebookId);
      if (!row) return;
      const pageIndex = typeof detail.pageIndex === "number" ? detail.pageIndex : detail.chunkIndex ?? 0;
      const pages = ebookSpeechPages(row);
      const pageText = pages[Math.max(0, Math.min(pageIndex, Math.max(pages.length - 1, 0)))] ?? "";
      const startOffset = snapEbookStartOffset(pageText, detail.charIndex, detail.word);
      bumpResumeHints();
      if (detail.source === "navigation") {
        if (ebookNavigationStartTimerRef.current != null) {
          window.clearTimeout(ebookNavigationStartTimerRef.current);
          ebookNavigationStartTimerRef.current = null;
        }
        ebookStopRef.current = true;
        ebookSpeechRunRef.current += 1;
        ebookTtsPlaybackStartedRef.current = false;
        ebookNeuralPrefetchKeyRef.current = "";
        if (ebookNextTimerRef.current != null) {
          window.clearTimeout(ebookNextTimerRef.current);
          ebookNextTimerRef.current = null;
        }
        if (ebookNeuralPrefetchTimerRef.current != null) {
          window.clearTimeout(ebookNeuralPrefetchTimerRef.current);
          ebookNeuralPrefetchTimerRef.current = null;
        }
        if (ebookAudioRef.current) {
          ebookAudioRef.current.pause();
          ebookAudioRef.current.removeAttribute("src");
          ebookAudioRef.current.load();
        }
        void window.iptv?.cancelNeuralTts?.();
        dispatchEbookTtsActive(ebookActiveIdRef.current, false);
        setEbookNeuralStatusLight("Preparing selected page...");
        setEbook((cur) =>
          cur
            ? {
                ...cur,
                status: "idle",
                chunkIndex: Math.max(0, Math.min(pageIndex, Math.max(pages.length - 1, 0))) + 1,
                chunkCount: pages.length,
              }
            : cur
        );
        ebookNavigationStartTimerRef.current = window.setTimeout(() => {
          ebookNavigationStartTimerRef.current = null;
          loadEbookInReader(row, pageIndex, startOffset, true);
        }, 450);
        return;
      }
      loadEbookInReader(row, pageIndex, startOffset, true);
    };
    window.addEventListener(EBOOK_START_EVENT, onStartAt);
    return () => window.removeEventListener(EBOOK_START_EVENT, onStartAt);
  }, [bumpResumeHints, ebookRows, loadEbookInReader, setEbookNeuralStatusLight]);

  const playEbookFromStart = useCallback(
    (row: StoredEbook, ev?: React.MouseEvent) => {
      ev?.preventDefault();
      ev?.stopPropagation();
      clearEbookResume(row.id);
      bumpResumeHints();
      loadEbookInReader(row, 0, 0, true);
    },
    [bumpResumeHints, loadEbookInReader]
  );

  const playEbookResume = useCallback(
    (row: StoredEbook, ev?: React.MouseEvent) => {
      ev?.preventDefault();
      ev?.stopPropagation();
      bumpResumeHints();
      loadEbookInReader(row, loadEbookResumeChunk(row.id) ?? 0, 0, true);
    },
    [bumpResumeHints, loadEbookInReader]
  );

  const pauseActiveEbook = useCallback(
    (ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      pauseEbook();
    },
    [pauseEbook]
  );

  const resumeHints = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const sec = loadAudioResumeSeconds(r.track.id);
      if (sec != null && sec >= 3) m.set(r.track.id, sec);
    }
    return m;
  }, [rows, resumeTick]);

  const ebookResumeHints = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of ebookRows) {
      const idx = loadEbookResumeChunk(r.id);
      if (idx != null) m.set(r.id, idx);
    }
    return m;
  }, [ebookRows, resumeTick]);
  const selectedNeuralVoice = ebookNeuralVoices.find((v) => v.id === ebookNeuralVoiceId) ?? null;

  return (
    <div className="local-audio-root">
      <div className="local-audio-toolbar">
        {hasDesktopPick ? (
          <button type="button" className="url-btn" disabled={busy} onClick={() => void onAddDesktop()}>
            Add folder to Library…
          </button>
        ) : (
          <label className={`file-btn local-audio-pick${busy ? " file-btn--disabled" : ""}`}>
            <input
              type="file"
              className="local-audio-file-input"
              multiple
              // @ts-expect-error non-standard but widely supported for folder import
              webkitdirectory=""
              directory=""
              accept={LIBRARY_ACCEPT}
              disabled={busy}
              onChange={(e) => void onPickLibraryFiles(e)}
            />
            <span className="local-audio-pick-text">Add folder to Library…</span>
          </label>
        )}
        <div ref={ebookVoiceControlsRef} className="ebook-voice-controls" aria-label="Ebook voice settings">
          <div className="ebook-voice-toggle" role="group" aria-label="Narrator voice gender">
            <button
              type="button"
              className={`ebook-voice-toggle-btn${ebookVoiceGender === "female" ? " ebook-voice-toggle-btn--active" : ""}`}
              disabled={busy}
              onClick={() => setEbookVoiceGender("female")}
            >
              Female
            </button>
            <button
              type="button"
              className={`ebook-voice-toggle-btn${ebookVoiceGender === "male" ? " ebook-voice-toggle-btn--active" : ""}`}
              disabled={busy}
              onClick={() => setEbookVoiceGender("male")}
            >
              Male
            </button>
          </div>
          <div className={`ebook-voice-scale${ebookTtsScaleLocked ? " ebook-voice-scale--locked" : ""}`}>
            <button
              type="button"
              className={`ebook-voice-scale-btn${ebookVoiceScaleOpen === "speed" ? " ebook-voice-scale-btn--open" : ""}`}
              aria-label={`Read speed ${ebookSpeechRateDraft.toFixed(2)}x`}
              aria-expanded={ebookVoiceScaleOpen === "speed"}
              aria-disabled={ebookTtsScaleLocked}
              disabled={ebookTtsScaleLocked}
              title={ebookTtsScaleLocked ? "Pause reading to change speed" : undefined}
              onClick={() => setEbookVoiceScaleOpen((cur) => (cur === "speed" ? null : "speed"))}
            >
              Speed {ebookSpeechRateDraft.toFixed(2)}x
            </button>
            {ebookVoiceScaleOpen === "speed" && !ebookTtsScaleLocked ? (
              <div className="ebook-voice-scale-popover" role="dialog" aria-label="Read speed scale">
                <div className="ebook-voice-scale-popover-inner">
                  <span className="ebook-voice-scale-title">Speed</span>
                  <input
                    className="ebook-voice-scale-range"
                    type="range"
                    min={0.65}
                    max={1.35}
                    step={0.05}
                    value={ebookSpeechRateDraft}
                    onChange={(e) => setEbookSpeechRateDraft(Number(e.currentTarget.value))}
                    onPointerUp={commitEbookRateDraft}
                    onPointerCancel={commitEbookRateDraft}
                    onMouseUp={commitEbookRateDraft}
                    onTouchEnd={commitEbookRateDraft}
                    onKeyUp={commitEbookRateDraft}
                    onBlur={commitEbookRateDraft}
                  />
                  <span className="ebook-voice-scale-readout">{ebookSpeechRateDraft.toFixed(2)}x</span>
                </div>
              </div>
            ) : null}
          </div>
          <div className={`ebook-voice-scale${ebookTtsScaleLocked ? " ebook-voice-scale--locked" : ""}`}>
            <button
              type="button"
              className={`ebook-voice-scale-btn${ebookVoiceScaleOpen === "pitch" ? " ebook-voice-scale-btn--open" : ""}`}
              aria-label={`Pitch ${ebookSpeechPitchDraft.toFixed(2)}x`}
              aria-expanded={ebookVoiceScaleOpen === "pitch"}
              aria-disabled={ebookTtsScaleLocked}
              disabled={ebookTtsScaleLocked}
              title={ebookTtsScaleLocked ? "Pause reading to change pitch" : undefined}
              onClick={() => setEbookVoiceScaleOpen((cur) => (cur === "pitch" ? null : "pitch"))}
            >
              Pitch {ebookSpeechPitchDraft.toFixed(2)}x
            </button>
            {ebookVoiceScaleOpen === "pitch" && !ebookTtsScaleLocked ? (
              <div className="ebook-voice-scale-popover" role="dialog" aria-label="Pitch scale">
                <div className="ebook-voice-scale-popover-inner">
                  <span className="ebook-voice-scale-title">Pitch</span>
                  <input
                    className="ebook-voice-scale-range"
                    type="range"
                    min={0.75}
                    max={1.25}
                    step={0.05}
                    value={ebookSpeechPitchDraft}
                    onChange={(e) => setEbookSpeechPitchDraft(Number(e.currentTarget.value))}
                    onPointerUp={commitEbookPitchDraft}
                    onPointerCancel={commitEbookPitchDraft}
                    onMouseUp={commitEbookPitchDraft}
                    onTouchEnd={commitEbookPitchDraft}
                    onKeyUp={commitEbookPitchDraft}
                    onBlur={commitEbookPitchDraft}
                  />
                  <span className="ebook-voice-scale-readout">{ebookSpeechPitchDraft.toFixed(2)}x</span>
                </div>
              </div>
            ) : null}
          </div>
          <span className="ebook-neural-status">
            Neural TTS · {selectedNeuralVoice?.name ?? (ebookVoiceGender === "male" ? "Male voice" : "Female voice")}
            {ebookNeuralStatus ? ` · ${ebookNeuralStatus}` : ""}
          </span>
        </div>
        {busy ? (
          <span className="local-audio-hourglass" role="status" aria-live="polite" aria-label="Loading audio files">
            <span className="local-audio-hourglass-icon" aria-hidden>
              ⏳
            </span>
          </span>
        ) : null}
        <div className="local-audio-toolbar-playback">
          <AudioLibraryPlaybackControls
            shuffle={audioLibraryShuffle}
            continuous={audioLibraryContinuous}
            onShuffleChange={onAudioLibraryShuffleChange}
            onContinuousChange={onAudioLibraryContinuousChange}
            onClearAll={() => void onClearAll()}
            clearDisabled={busy || rows.length + ebookRows.length === 0}
          />
        </div>
      </div>

      {err ? <p className="local-audio-err">{err}</p> : null}

      <div className="local-audio-scroll">
        {rows.length + ebookRows.length === 0 ? (
          <div className="local-audio-empty">
            <p>
              No files yet — use <strong>Add to Library…</strong> to import songs, audiobooks, or ebooks. Imports stay
              in this profile until you remove them.
            </p>
            <div className="local-audio-empty-formats">
              <p>Songs: MP3, M4A, AAC, OGG, Opus, WAV, FLAC, WebM</p>
              <p>Audiobooks: M4B, M4A</p>
              <p>Ebooks: PDF, EPUB, TXT, Markdown, HTML</p>
            </div>
          </div>
        ) : (
          <>
          {ebookRows.map((book) => {
            const ch = channelFromEbook(book, ebookResumeHints.get(book.id) ?? 0);
            const active =
              ebook?.id === book.id ||
              ch.id === activeLeftId ||
              (splitView && ch.id === activeRightId);
            const resumeAt = ebookResumeHints.get(book.id);
            const rowClass = active ? "local-audio-row active active--ebook" : "local-audio-row";
            const isSpeaking = active && ebook?.status === "speaking";
            const isPreparing = active && ebook?.status === "preparing";
            const isPaused = active && ebook?.status === "paused";
            const progress =
              active && ebook
                ? isPreparing
                  ? "Preparing voice…"
                  : ebook.status === "idle" && ebook.chunkIndex >= ebook.chunkCount
                  ? "Finished"
                  : `Part ${Math.min(ebook.chunkIndex || 1, ebook.chunkCount)} of ${ebook.chunkCount}`
                : resumeAt != null
                  ? `Resume at part ${resumeAt + 1}`
                  : "Start from beginning";
            return (
              <div key={book.id} className={rowClass} title={`${book.sourceFileName} · ${progress}`}>
                <button
                  type="button"
                  className="local-audio-row-hit"
                  title={`${book.sourceFileName} · ${progress}`}
                  onClick={(ev) => openEbookForReading(book, ev)}
                >
                  <span className="local-audio-icon local-audio-icon--ebook" aria-hidden>
                    E
                  </span>
                  <span className="local-audio-meta">
                    <span className="local-audio-name">{book.title}</span>
                    <span className="local-audio-tag-line">Ebook · {progress}</span>
                  </span>
                </button>
                <div className="local-audio-row-actions" aria-label="Ebook playback">
                  <button
                    type="button"
                    className="local-audio-pos-btn"
                    title="Start from beginning"
                    aria-label={`Start ${book.title} from beginning`}
                    disabled={busy}
                    onClick={(ev) => playEbookFromStart(book, ev)}
                  >
                    <span className="local-audio-pos-glyph" aria-hidden>
                      ↺
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`local-audio-pos-btn local-audio-pos-btn--resume${resumeAt != null || active ? " local-audio-pos-btn--has-time" : ""}`}
                    title={
                      isPreparing
                        ? "Cancel read-out preparation"
                        : isSpeaking
                        ? "Pause read-out"
                        : isPaused
                          ? "Resume from the paused word"
                          : resumeAt != null
                            ? `Resume at part ${resumeAt + 1}`
                            : "Start read-out"
                    }
                    aria-label={
                      isPreparing
                        ? `Cancel ${book.title} read-out preparation`
                        : isSpeaking
                        ? `Pause ${book.title}`
                        : isPaused
                          ? `Resume ${book.title} from paused word`
                          : `Resume ${book.title}`
                    }
                    disabled={busy}
                    onClick={(ev) =>
                      isPreparing
                        ? (ev.preventDefault(), ev.stopPropagation(), stopEbookSpeech())
                        : isSpeaking
                          ? pauseActiveEbook(ev)
                          : isPaused
                            ? resumePausedEbook(ev)
                            : playEbookResume(book, ev)
                    }
                  >
                    <span
                      className={`local-audio-pos-glyph${isPreparing ? " local-audio-pos-glyph--loading" : ""}`}
                      aria-hidden
                    >
                      {isPreparing ? "" : isSpeaking ? "Ⅱ" : "▶"}
                    </span>
                    {resumeAt != null && !isSpeaking && !isPreparing ? (
                      <span className="local-audio-pos-time">P{resumeAt + 1}</span>
                    ) : null}
                  </button>
                </div>
                <button
                  type="button"
                  className="local-audio-del"
                  title="Remove from library"
                  aria-label={`Remove ${book.title}`}
                  disabled={busy}
                  onClick={(ev) => void onRemoveEbook(book.id, ev)}
                >
                  ×
                </button>
              </div>
            );
          })}
          {rows.map((r) => {
            const t = r.track;
            const ch = channelFromLibraryTrack(t, r.url);
            const leftOn = ch.id === activeLeftId;
            const rightOn = splitView && ch.id === activeRightId;
            const active = leftOn || rightOn;
            const playback = libraryPlaybackState?.trackId === t.id ? libraryPlaybackState : null;
            const isPlaying = active && playback?.paused !== true;
            const isPaused = active && playback?.paused === true;
            const rowClass =
              active
                ? `local-audio-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}`
                : "local-audio-row";
            const resumeAt = resumeHints.get(t.id);
            const tagLine =
              r.tagArtist && r.tagTitle
                ? `${r.tagArtist} — ${r.tagTitle}`
                : r.tagTitle || r.tagArtist || "";
            const rowTooltip =
              r.tagsTooltip?.trim() ||
              (tagLine ? `Tags: ${tagLine}` : "Reading embedded file tags…");
            return (
              <div key={t.id} className={rowClass} title={rowTooltip}>
                <button
                  type="button"
                  className="local-audio-row-hit"
                  title={rowTooltip}
                  onClick={() => playRow(r)}
                >
                  {r.thumbUrl ? (
                    <img className="local-audio-thumb" src={r.thumbUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="local-audio-icon" aria-hidden>
                      ♪
                    </span>
                  )}
                  <span className="local-audio-meta">
                    <span className="local-audio-name">{t.name}</span>
                    {tagLine ? <span className="local-audio-tag-line">{tagLine}</span> : null}
                  </span>
                </button>
                <div className="local-audio-row-actions" aria-label="Playback">
                  <button
                    type="button"
                    className="local-audio-pos-btn"
                    title="Start from beginning"
                    aria-label={`Start ${t.name} from beginning`}
                    disabled={busy}
                    onClick={(ev) => playFromStart(r, ev)}
                  >
                    <span className="local-audio-pos-glyph" aria-hidden>
                      ↺
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`local-audio-pos-btn local-audio-pos-btn--resume${resumeAt != null || active ? " local-audio-pos-btn--has-time" : ""}`}
                    title={
                      isPlaying
                        ? "Pause song"
                        : isPaused
                          ? "Resume song"
                          : resumeAt != null
                            ? `Resume at ${formatResume(resumeAt)}`
                            : "Play song"
                    }
                    aria-label={
                      isPlaying
                        ? `Pause ${t.name}`
                        : isPaused
                          ? `Resume ${t.name}`
                          : resumeAt != null
                        ? `Resume ${t.name} at ${formatResume(resumeAt)}`
                        : `Play ${t.name}`
                    }
                    disabled={busy}
                    onClick={(ev) => toggleAudioTrackPlayback(r, active, ev)}
                  >
                    <span className="local-audio-pos-glyph" aria-hidden>
                      {isPlaying ? "Ⅱ" : "▶"}
                    </span>
                    {resumeAt != null && !isPlaying ? (
                      <span className="local-audio-pos-time">{formatResume(resumeAt)}</span>
                    ) : null}
                  </button>
                </div>
                <button
                  type="button"
                  className="local-audio-del"
                  title="Remove from library"
                  aria-label={`Remove ${t.name}`}
                  disabled={busy}
                  onClick={(ev) => void onRemove(t.id, ev)}
                >
                  ×
                </button>
              </div>
            );
          })}
          </>
        )}
      </div>

      <details className="local-audio-translate-details">
        <summary className="local-audio-translate-summary">
          Lyrics translation — LLM API (optional)
        </summary>
        <div className="local-audio-translate-details-body">
          <LyricsChatTranslateSettings />
        </div>
      </details>
    </div>
  );
});
