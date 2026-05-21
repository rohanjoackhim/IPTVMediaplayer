import {
  attachLiveCaptionAudioTap,
  detachLiveCaptionAudioTap,
  resumeEqContextForPlayback,
  type LiveCaptionAudioTap,
} from "./eqAudioGraph";

/** Live radio caption segment from local Whisper STT. */
export interface RadioCaptionSegment {
  id: number;
  text: string;
  translated?: string;
  at: number;
  /** When true, replace the previous segment in the UI (same utterance refined). */
  replaceLast?: boolean;
}

const WHISPER_SAMPLE_RATE = 16000;
/** Audio window sent to Whisper — shorter window + hop for smoother in-place growth. */
const WINDOW_SEC = 2.5;
const HOP_SEC = 1;
/** UI refine updates batched to reduce flicker while staying responsive. */
const REFINE_EMIT_MS = 180;
const MIN_WINDOW_SAMPLES = Math.floor(WHISPER_SAMPLE_RATE * 0.45);

export function canUseRadioLiveCaptions(): boolean {
  return typeof window !== "undefined" && !!window.iptv?.whisperWarmup && !!window.iptv?.whisperTranscribePcm;
}

export interface RadioLiveCaptionsController {
  stop: () => void;
}

function playbackLevel(media: HTMLMediaElement): number {
  return Math.min(1, Math.max(0, media.volume));
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === WHISPER_SAMPLE_RATE) return input;
  const ratio = inputRate / WHISPER_SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0;
  }
  return out;
}

function normalizeCaptionText(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Collapse Whisper/translation spam: "word word word" → "word", repeated phrases → once. */
export function collapseRepeatedCaptionWords(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  if (!t) return t;

  t = t.replace(/\b([\p{L}\p{N}'’-]+)\b(?:\s+\1\b){2,}/giu, "$1");

  const words = t.split(/\s+/);
  if (words.length >= 6) {
    const counts = new Map<string, number>();
    for (const w of words) {
      const k = w.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let dominant: string | null = null;
    let dominantCount = 0;
    for (const [k, c] of counts) {
      if (c > dominantCount) {
        dominantCount = c;
        dominant = k;
      }
    }
    if (dominant && dominantCount >= 5 && dominantCount / words.length >= 0.4) {
      let kept = 0;
      const filtered: string[] = [];
      for (const w of words) {
        if (w.toLowerCase() === dominant) {
          kept++;
          if (kept > 2) continue;
        }
        filtered.push(w);
      }
      t = filtered.join(" ");
    }
  }

  return collapseConsecutivePhraseRepeats(t);
}

function collapseConsecutivePhraseRepeats(text: string): string {
  const words = text.split(/\s+/);
  if (words.length < 4) return text;

  for (let phraseLen = Math.min(4, Math.floor(words.length / 3)); phraseLen >= 1; phraseLen--) {
    let i = 0;
    const out: string[] = [];
    let changed = false;
    while (i < words.length) {
      const phrase = words
        .slice(i, i + phraseLen)
        .map((w) => w.toLowerCase())
        .join(" ");
      if (!phrase) {
        i++;
        continue;
      }
      let reps = 1;
      let j = i + phraseLen;
      while (j + phraseLen <= words.length) {
        const next = words
          .slice(j, j + phraseLen)
          .map((w) => w.toLowerCase())
          .join(" ");
        if (next !== phrase) break;
        reps++;
        j += phraseLen;
      }
      if (reps >= 3) {
        out.push(...words.slice(i, i + phraseLen));
        i = j;
        changed = true;
      } else {
        out.push(words[i]!);
        i++;
      }
    }
    if (changed) return collapseConsecutivePhraseRepeats(out.join(" "));
  }
  return text;
}

/** Deduplicate consecutive identical lines before calling translate APIs. */
export function prepareRadioCaptionLinesForTranslation(lines: string[]): {
  texts: string[];
  lineToSegmentIndex: number[];
} {
  const texts: string[] = [];
  const lineToSegmentIndex: number[] = [];
  let lastNorm = "";
  for (let i = 0; i < lines.length; i++) {
    const t = collapseRepeatedCaptionWords(lines[i] ?? "");
    if (!t) continue;
    const norm = t.toLowerCase();
    if (norm === lastNorm) continue;
    lastNorm = norm;
    texts.push(t);
    lineToSegmentIndex.push(i);
  }
  return { texts, lineToSegmentIndex };
}

export function mapRadioTranslationsToSegments(
  segmentCount: number,
  lineToSegmentIndex: number[],
  translatedLines: string[],
  originalLines: string[]
): string[] {
  const byIndex: (string | undefined)[] = new Array(segmentCount);
  for (let j = 0; j < lineToSegmentIndex.length; j++) {
    const idx = lineToSegmentIndex[j]!;
    byIndex[idx] = translatedLines[j]?.trim();
  }
  for (let i = 0; i < segmentCount; i++) {
    if (byIndex[i] != null) continue;
    const norm = collapseRepeatedCaptionWords(originalLines[i] ?? "").toLowerCase();
    if (!norm) continue;
    for (let k = i - 1; k >= 0; k--) {
      if (collapseRepeatedCaptionWords(originalLines[k] ?? "").toLowerCase() === norm) {
        byIndex[i] = byIndex[k];
        break;
      }
    }
  }
  return Array.from({ length: segmentCount }, (_, i) => byIndex[i]?.trim() || originalLines[i] || "");
}

function wordSuffixPrefixOverlap(prevWords: string[], nextWords: string[]): number {
  const maxK = Math.min(prevWords.length, nextWords.length);
  for (let k = maxK; k >= 1; k--) {
    const suffix = prevWords
      .slice(-k)
      .map((w) => w.toLowerCase())
      .join(" ");
    const prefix = nextWords
      .slice(0, k)
      .map((w) => w.toLowerCase())
      .join(" ");
    if (suffix === prefix) return k;
  }
  return 0;
}

/** Merge overlapping utterances so captions grow in place instead of jumping to new lines. */
export function mergeRadioCaptionUtterance(
  prev: string,
  next: string
): { text: string; replaceLast: boolean } {
  const p = normalizeCaptionText(prev);
  const n = normalizeCaptionText(next);
  if (!n) return { text: prev, replaceLast: true };
  if (!p) return { text: next.trim(), replaceLast: false };
  if (n === p) return { text: prev, replaceLast: true };
  if (n.startsWith(p)) return { text: next.trim(), replaceLast: true };
  if (p.startsWith(n)) return { text: prev, replaceLast: true };

  const pw = prev.trim().split(/\s+/).filter(Boolean);
  const nw = next.trim().split(/\s+/).filter(Boolean);
  const overlap = wordSuffixPrefixOverlap(pw, nw);
  if (overlap > 0) {
    return { text: [...pw, ...nw.slice(overlap)].join(" "), replaceLast: true };
  }
  return { text: next.trim(), replaceLast: false };
}

/**
 * Low-latency PCM capture → local Whisper (no MediaRecorder / FFmpeg per chunk).
 */
export function startRadioLiveCaptions(
  media: HTMLMediaElement,
  handlers: {
    onStatus: (status: string) => void;
    onSegment: (segment: RadioCaptionSegment) => void;
    onError: (message: string) => void;
  }
): RadioLiveCaptionsController {
  let stopped = false;
  let sessionGen = 0;
  let segmentId = 0;
  let lastCaptionText = "";
  const audioCapture = {
    ctx: null as AudioContext | null,
    processor: null as ScriptProcessorNode | null,
    tap: null as LiveCaptionAudioTap | null,
  };
  let pcmQueue: number[] = [];
  let pendingPcm: Float32Array | null = null;
  let inFlight = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingEmit: RadioCaptionSegment | null = null;

  const windowSamples = Math.floor(WHISPER_SAMPLE_RATE * WINDOW_SEC);
  const hopSamples = Math.floor(WHISPER_SAMPLE_RATE * HOP_SEC);

  const stop = () => {
    sessionGen++;
    stopped = true;
    pendingPcm = null;
    pcmQueue = [];
    lastCaptionText = "";
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    pendingEmit = null;
    if (audioCapture.tap) {
      detachLiveCaptionAudioTap(audioCapture.tap, media, playbackLevel(media));
      audioCapture.tap = null;
    }
    audioCapture.processor = null;
    audioCapture.ctx = null;
  };

  const flushPendingEmit = () => {
    if (!pendingEmit) return;
    const seg = pendingEmit;
    pendingEmit = null;
    handlers.onSegment(seg);
  };

  const emitCaption = (raw: string) => {
    const trimmed = collapseRepeatedCaptionWords(raw);
    if (!trimmed) return;
    const { text, replaceLast } = mergeRadioCaptionUtterance(lastCaptionText, trimmed);
    lastCaptionText = text;
    const seg: RadioCaptionSegment = replaceLast
      ? { id: segmentId, text, at: Date.now(), replaceLast: true }
      : { id: ++segmentId, text, at: Date.now(), replaceLast: false };

    if (replaceLast) {
      pendingEmit = seg;
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = setTimeout(() => {
        emitTimer = null;
        flushPendingEmit();
      }, REFINE_EMIT_MS);
      return;
    }

    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
      flushPendingEmit();
    }
    pendingEmit = null;
    handlers.onSegment(seg);
  };

  const pumpTranscribe = () => {
    if (inFlight || !pendingPcm || stopped) return;
    inFlight = true;
    const pcm = pendingPcm;
    pendingPcm = null;
    const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);

    void window.iptv!
      .whisperTranscribePcm!(buf)
      .then((res) => {
        if (stopped) return;
        if (!res.ok) {
          if (res.error && !/invalid|ebml/i.test(res.error)) handlers.onError(res.error);
          return;
        }
        if (res.text?.trim()) emitCaption(res.text);
      })
      .catch((e) => {
        if (!stopped) handlers.onError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        inFlight = false;
        if (pendingPcm && !stopped) pumpTranscribe();
      });
  };

  const queuePcmWindow = (samples: Float32Array) => {
    if (stopped || samples.length < MIN_WINDOW_SAMPLES) return;
    pendingPcm = samples;
    pumpTranscribe();
  };

  const pushSamples = (down: Float32Array) => {
    for (let i = 0; i < down.length; i++) pcmQueue.push(down[i]!);
    while (pcmQueue.length >= windowSamples) {
      const window = pcmQueue.slice(0, windowSamples);
      pcmQueue.splice(0, hopSamples);
      queuePcmWindow(new Float32Array(window));
    }
  };

  void (async () => {
    const gen = sessionGen;
    const alive = () => !stopped && gen === sessionGen;

    if (!canUseRadioLiveCaptions()) {
      handlers.onError("Live captions need the desktop app with local Whisper.");
      return;
    }
    let loadMsg = "Loading local Whisper model (first run may download ~75 MB)…";
    try {
      const st = await window.iptv!.whisperStatus?.();
      if (st?.modelLabel || st?.modelKey) {
        const label = st.modelLabel ?? st.modelKey ?? "tiny";
        const hint = st.downloadHint ?? "~75 MB";
        loadMsg = `Loading Whisper ${label} (first run may download ${hint})…`;
      }
    } catch {
      /* use default */
    }
    handlers.onStatus(loadMsg);
    const warm = await window.iptv!.whisperWarmup!();
    if (!alive()) return;
    if (!warm.ok) {
      handlers.onError(warm.error || "Could not load Whisper model.");
      return;
    }

    try {
      const ctx = await resumeEqContextForPlayback();
      if (!alive()) return;
      if (!ctx) {
        handlers.onError("Web Audio is not available.");
        return;
      }
      audioCapture.ctx = ctx;
      audioCapture.processor = ctx.createScriptProcessor(4096, 1, 1);
      const inputRate = ctx.sampleRate;
      audioCapture.processor.onaudioprocess = (ev) => {
        if (!alive()) return;
        const input = ev.inputBuffer.getChannelData(0);
        pushSamples(downsampleTo16k(input, inputRate));
      };

      audioCapture.tap = await attachLiveCaptionAudioTap(
        media,
        audioCapture.processor,
        playbackLevel(media)
      );
      if (!alive()) {
        if (audioCapture.tap) {
          detachLiveCaptionAudioTap(audioCapture.tap, media, playbackLevel(media));
          audioCapture.tap = null;
        }
        return;
      }

      handlers.onStatus(
        media.paused
          ? "Live captions ready — press play to transcribe."
          : "Live captions — smooth updates about every second (local Whisper; radio and podcasts)."
      );
    } catch (e) {
      if (alive()) handlers.onError(e instanceof Error ? e.message : String(e));
    }
  })();

  return { stop };
}
