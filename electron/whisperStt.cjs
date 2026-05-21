/**
 * Local Whisper STT for live radio captions (Electron main process).
 * Uses @xenova/transformers (ONNX). Prefer PCM Float32 @ 16 kHz from the renderer (low latency).
 */
"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

/** @type {Record<string, { id: string, label: string, downloadHint: string }>} */
const WHISPER_MODELS = {
  tiny: { id: "Xenova/whisper-tiny", label: "Tiny", downloadHint: "~75 MB" },
  base: { id: "Xenova/whisper-base", label: "Base", downloadHint: "~150 MB" },
  small: { id: "Xenova/whisper-small", label: "Small", downloadHint: "~460 MB" },
};

const DEFAULT_MODEL_KEY = "tiny";
const WHISPER_MODEL_ID = WHISPER_MODELS[DEFAULT_MODEL_KEY].id;

const MAX_CHUNK_BYTES = 6 * 1024 * 1024;
const MIN_PCM_SAMPLES = Math.floor(16000 * 0.45);

/** @type {{ app: import('electron').App, getFfmpegPath: () => string | null, runFfmpeg: (ffmpegPath: string, args: string[]) => Promise<void> } | null} */
let deps = null;

let currentModelKey = DEFAULT_MODEL_KEY;
let pipelinePromise = null;
let loadError = null;
let isLoading = false;
let transcribeQueue = Promise.resolve();

function initWhisperStt(depsIn) {
  deps = depsIn;
}

function resolveModelKey(key) {
  if (typeof key === "string" && WHISPER_MODELS[key]) return key;
  return DEFAULT_MODEL_KEY;
}

function getCurrentModelId() {
  return WHISPER_MODELS[currentModelKey].id;
}

function resetPipeline() {
  pipelinePromise = null;
  loadError = null;
  isLoading = false;
}

function listWhisperModels() {
  return Object.entries(WHISPER_MODELS).map(([key, m]) => ({
    key,
    id: m.id,
    label: m.label,
    downloadHint: m.downloadHint,
  }));
}

function whisperCacheDir() {
  if (!deps?.app) throw new Error("Whisper STT is not initialized.");
  return path.join(deps.app.getPath("userData"), "whisper-models");
}

function whisperTempDir() {
  if (!deps?.app) throw new Error("Whisper STT is not initialized.");
  const dir = path.join(deps.app.getPath("temp"), "iptv-whisper-chunks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getWhisperStatus() {
  const meta = WHISPER_MODELS[currentModelKey];
  return {
    modelKey: currentModelKey,
    modelId: getCurrentModelId(),
    modelLabel: meta?.label ?? "Tiny",
    downloadHint: meta?.downloadHint ?? "~75 MB",
    models: listWhisperModels(),
    ready: !!pipelinePromise && !loadError && !isLoading,
    loading: isLoading,
    error: loadError ? String(loadError.message || loadError) : null,
  };
}

/**
 * Select which Xenova Whisper weights to load. Unloads the previous pipeline.
 * @param {string} modelKey tiny | base | small
 */
async function setWhisperModel(modelKey) {
  const key = resolveModelKey(modelKey);
  const changed = key !== currentModelKey;
  currentModelKey = key;
  if (changed || loadError || !pipelinePromise) {
    resetPipeline();
  }
  return {
    ok: true,
    modelKey: key,
    modelId: getCurrentModelId(),
  };
}

function enqueueTranscribe(fn) {
  const run = transcribeQueue.then(fn);
  transcribeQueue = run.catch(() => {});
  return run;
}

async function getPipeline() {
  if (loadError) throw loadError;
  const modelId = getCurrentModelId();
  if (!pipelinePromise) {
    isLoading = true;
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      env.cacheDir = whisperCacheDir();
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      return pipeline("automatic-speech-recognition", modelId);
    })()
      .catch((e) => {
        loadError = e;
        pipelinePromise = null;
        throw e;
      })
      .finally(() => {
        isLoading = false;
      });
  }
  return pipelinePromise;
}

async function warmupWhisper() {
  try {
    await getPipeline();
    return { ok: true, modelKey: currentModelKey, modelId: getCurrentModelId() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** @param {Float32Array} audioData */
async function runWhisperOnFloat32(audioData) {
  if (!audioData?.length) return "";
  const transcriber = await getPipeline();
  const output = await transcriber(audioData, {
    sampling_rate: 16000,
    task: "transcribe",
    return_timestamps: false,
    max_new_tokens: 96,
  });
  return typeof output === "string"
    ? output
    : typeof output?.text === "string"
      ? output.text
      : Array.isArray(output?.chunks)
        ? output.chunks.map((c) => c?.text ?? "").join(" ").trim()
        : "";
}

/**
 * Real-time path: Float32 PCM mono @ 16 kHz from Web Audio (no FFmpeg).
 * @param {ArrayBuffer} pcmBuffer
 */
async function transcribePcmFloat32(pcmBuffer) {
  if (!deps) return { ok: false, error: "Whisper STT is not available." };
  let buf = pcmBuffer;
  if (ArrayBuffer.isView(pcmBuffer)) {
    buf = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength);
  } else if (!(pcmBuffer instanceof ArrayBuffer)) {
    return { ok: false, error: "Invalid PCM buffer." };
  }
  const byteLen = buf.byteLength;
  if (byteLen < MIN_PCM_SAMPLES * 4) return { ok: true, text: "" };
  if (byteLen > MAX_CHUNK_BYTES) return { ok: false, error: "Audio chunk too large." };

  return enqueueTranscribe(async () => {
    try {
      const audioData = new Float32Array(buf);
      const text = String((await runWhisperOnFloat32(audioData)) || "").trim();
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** @param {Buffer} wavBuffer */
function wavBufferToFloat32Mono16k(wavBuffer) {
  const { WaveFile } = require("wavefile");
  const wav = new WaveFile(wavBuffer);
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let audioData = wav.getSamples();
  if (Array.isArray(audioData)) {
    if (audioData.length > 1) {
      const scale = Math.sqrt(2);
      for (let i = 0; i < audioData[0].length; ++i) {
        audioData[0][i] = (scale * (audioData[0][i] + audioData[1][i])) / 2;
      }
    }
    audioData = audioData[0];
  }
  if (!(audioData instanceof Float32Array)) {
    audioData = Float32Array.from(audioData);
  }
  return audioData;
}

function mediaContainerExt(buf) {
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return "webm";
  }
  if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return "ogg";
  }
  return null;
}

/**
 * @param {ArrayBuffer | Buffer} mediaBuf
 */
async function transcribeWebmChunk(mediaBuf) {
  if (!deps) return { ok: false, error: "Whisper STT is not available." };
  const buf = Buffer.isBuffer(mediaBuf) ? mediaBuf : Buffer.from(mediaBuf);
  if (buf.length < 800) return { ok: true, text: "" };
  if (buf.length > MAX_CHUNK_BYTES) {
    return { ok: false, error: "Audio chunk too large." };
  }
  const ext = mediaContainerExt(buf);
  if (!ext) {
    return { ok: true, text: "" };
  }
  const ffmpegPath = deps.getFfmpegPath();
  if (!ffmpegPath) {
    return { ok: false, error: "FFmpeg is not bundled; cannot decode audio for Whisper." };
  }

  return enqueueTranscribe(async () => {
    const tempDir = whisperTempDir();
    const id = crypto.randomBytes(8).toString("hex");
    const inputPath = path.join(tempDir, `chunk-${id}.${ext}`);
    const wavPath = path.join(tempDir, `chunk-${id}.wav`);
    try {
      await fs.promises.writeFile(inputPath, buf);
      await deps.runFfmpeg(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ]);
      const wavBuffer = await fs.promises.readFile(wavPath);
      const audioData = wavBufferToFloat32Mono16k(wavBuffer);
      if (!audioData?.length) {
        return { ok: true, text: "" };
      }
      const text = await runWhisperOnFloat32(audioData);
      return { ok: true, text: String(text || "").trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      for (const p of [inputPath, wavPath]) {
        try {
          await fs.promises.unlink(p);
        } catch {
          /* noop */
        }
      }
    }
  });
}

module.exports = {
  initWhisperStt,
  getWhisperStatus,
  setWhisperModel,
  listWhisperModels,
  warmupWhisper,
  transcribeWebmChunk,
  transcribePcmFloat32,
  WHISPER_MODEL_ID,
};
