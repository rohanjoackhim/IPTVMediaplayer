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
/** Audio window sent to Whisper (~3 s) — longer phrases per caption update. */
const WINDOW_SEC = 3;
/** Advance capture hop (~1.5 s) — overlap for continuity without 8 s batching. */
const HOP_SEC = 1.5;
const MIN_WINDOW_SAMPLES = Math.floor(WHISPER_SAMPLE_RATE * 0.45);

export function canUseRadioLiveCaptions(): boolean {
  return typeof window !== "undefined" && !!window.iptv?.whisperWarmup && !!window.iptv?.whisperTranscribePcm;
}

export interface RadioLiveCaptionsController {
  stop: () => void;
}

function captureMediaAudioStream(media: HTMLMediaElement): MediaStream {
  const withCapture = media as HTMLMediaElement & { captureStream?: () => MediaStream };
  if (typeof withCapture.captureStream === "function") return withCapture.captureStream();
  throw new Error("captureStream is not supported for this media element.");
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

function mergeCaptionText(prev: string, next: string): { text: string; replaceLast: boolean } {
  const p = normalizeCaptionText(prev);
  const n = normalizeCaptionText(next);
  if (!n) return { text: prev, replaceLast: true };
  if (!p) return { text: next.trim(), replaceLast: false };
  if (n === p) return { text: prev, replaceLast: true };
  if (n.startsWith(p) || p.startsWith(n)) return { text: next.trim(), replaceLast: true };
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
  let segmentId = 0;
  let lastCaptionText = "";
  const audioCapture = {
    ctx: null as AudioContext | null,
    source: null as MediaStreamAudioSourceNode | null,
    processor: null as ScriptProcessorNode | null,
  };
  let pcmQueue: number[] = [];
  let pendingPcm: Float32Array | null = null;
  let inFlight = false;

  const windowSamples = Math.floor(WHISPER_SAMPLE_RATE * WINDOW_SEC);
  const hopSamples = Math.floor(WHISPER_SAMPLE_RATE * HOP_SEC);

  const stop = () => {
    stopped = true;
    pendingPcm = null;
    pcmQueue = [];
    lastCaptionText = "";
    try {
      audioCapture.processor?.disconnect();
      audioCapture.source?.disconnect();
    } catch {
      /* noop */
    }
    audioCapture.processor = null;
    audioCapture.source = null;
    try {
      audioCapture.ctx?.close();
    } catch {
      /* noop */
    }
    audioCapture.ctx = null;
  };

  const emitCaption = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const { text, replaceLast } = mergeCaptionText(lastCaptionText, trimmed);
    lastCaptionText = text;
    if (replaceLast) {
      handlers.onSegment({ id: segmentId, text, at: Date.now(), replaceLast: true });
    } else {
      handlers.onSegment({ id: ++segmentId, text, at: Date.now(), replaceLast: false });
    }
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
    if (!canUseRadioLiveCaptions()) {
      handlers.onError("Live captions need the desktop app with local Whisper.");
      return;
    }
    handlers.onStatus("Loading local Whisper model (first run may download ~75 MB)…");
    const warm = await window.iptv!.whisperWarmup!();
    if (stopped) return;
    if (!warm.ok) {
      handlers.onError(warm.error || "Could not load Whisper model.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = captureMediaAudioStream(media);
    } catch {
      handlers.onError("Could not capture audio from this stream.");
      return;
    }
    if (!stream.getAudioTracks().length) {
      handlers.onError("No audio track available to caption.");
      return;
    }

    try {
      audioCapture.ctx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
      await audioCapture.ctx.resume();
    } catch {
      try {
        audioCapture.ctx = new AudioContext();
        await audioCapture.ctx.resume();
      } catch (e) {
        handlers.onError(e instanceof Error ? e.message : "Web Audio is not available.");
        return;
      }
    }

    const ctx = audioCapture.ctx;
    audioCapture.source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    audioCapture.processor = ctx.createScriptProcessor(4096, 1, 1);
    const inputRate = ctx.sampleRate;

    audioCapture.processor.onaudioprocess = (ev) => {
      if (stopped) return;
      const input = ev.inputBuffer.getChannelData(0);
      pushSamples(downsampleTo16k(input, inputRate));
    };

    audioCapture.source.connect(audioCapture.processor);
    audioCapture.processor.connect(mute);
    mute.connect(ctx.destination);

    handlers.onStatus(
      "Live captions — longer phrases, updating every ~1–2 s (local Whisper; talk radio works best)."
    );
  })();

  return { stop };
}
