/// <reference types="vite/client" />

declare global {
  interface Window {
    /** Exposed by Electron `preload.cjs`. */
    iptv?: {
      fetchPlaylistText: (url: string) => Promise<string>;
      pickM3uPlaylistFile?: () => Promise<{
        ok: boolean;
        cancelled?: boolean;
        text?: string;
        fileName?: string;
        error?: string;
      }>;
      /** Desktop: extract one channel’s programmes from a large XMLTV URL (stream scan). */
      extractEpgProgrammes?: (payload: {
        url: string;
        channelId: string;
        fromMs: number;
        toMs: number;
      }) => Promise<{
        ok: boolean;
        programmes?: Array<{
          channelId: string;
          start: number;
          stop: number;
          title: string;
          description?: string;
        }>;
        error?: string;
      }>;
      /** Desktop: XMLTV channel id → display names (channel section only). */
      fetchEpgChannelIndex?: (url: string) => Promise<{
        ok: boolean;
        channelNames?: Record<string, string[]>;
        error?: string;
      }>;
      channelEpgLlm?: (payload: {
        name: string;
        tvgId?: string;
        country?: string;
        group?: string;
      }) => Promise<{
        ok: boolean;
        rawJson?: string;
        disclaimer?: string;
        error?: string;
        llmPurpose?: string;
        llmModel?: string;
        llmHost?: string;
      }>;
      /** Desktop: first YouTube search hit — `videoId` plus listing `title` (main process; title used for LRCLIB lyrics). */
      youtubeFirstVideoIdFromSearch: (query: string) => Promise<{ videoId: string; title?: string | null }>;
      /** Desktop: GET JSON from allow-listed https URLs (LRCLIB, MyMemory). */
      httpGetJson: (url: string) => Promise<unknown>;
      /** Desktop: fetch cover art when missing from file tags (iTunes Search). */
      fetchAlbumArtOnline: (payload: {
        artist: string;
        title: string;
        album?: string;
      }) => Promise<{ ok: boolean; mime?: string; data?: ArrayBuffer; error?: string }>;
      /** Desktop: LibreTranslate POST for lyrics (Argos / official public instances). */
      libreTranslate: (payload: { q: string; source: string; target?: string }) => Promise<unknown>;
      /** Desktop: Google Translate `translate_a/single` (client=gtx); short `q` only; returns `{ translatedText }`. */
      googleTranslateGtx: (payload: { q: string; source: string; target?: string }) => Promise<unknown>;
      getLyricsChatTranslateKeyStatus: () => Promise<{
        hasKey: boolean;
        hasDeepSeekKey?: boolean;
        hasOpenAiKey?: boolean;
        /** First provider used for automatic LLM calls: `deepseek` | `gemini` | `openai`. */
        primaryLlmProvider?: string;
        /** True if any LLM key is configured (DeepSeek, Gemini, or OpenAI). */
        hasSongMeaningKey?: boolean;
        hasGeminiFromEnv?: boolean;
        hasGeminiKey?: boolean;
        geminiKeyPreview?: string;
        geminiKeySource?: "env" | "app" | "";
        geminiModelPreview?: string;
        /** Safe preview only, e.g. `abcxxxxxyz`; never the full API key. */
        keyPreview?: string;
        /** Current OpenAI-compatible key source. */
        keySource?: "env" | "app" | "";
        apiBasePreview: string;
        modelPreview: string;
      }>;
      setLyricsChatTranslateCredentials: (payload: {
        key?: string;
        baseUrl?: string;
        model?: string;
        geminiKey?: string;
        geminiModel?: string;
      }) => Promise<{
        ok: boolean;
        hasKey: boolean;
        hasSongMeaningKey?: boolean;
        hasGeminiKey?: boolean;
        geminiKeyPreview?: string;
        geminiKeySource?: "env" | "app" | "";
        geminiModelPreview?: string;
        keyPreview?: string;
        keySource?: "env" | "app" | "";
        apiBasePreview: string;
        modelPreview: string;
      }>;
      /** Desktop: OpenAI-compatible chat translation; returns `{ translatedText }`. */
      lyricsChatTranslate: (payload: { q: string; source: string; target?: string }) => Promise<unknown>;
      /** Desktop: one-shot lyrics find + translate JSON (`ok`, `pairs`, `headline`, …). Same API key as `lyricsChatTranslate`. */
      lyricsLlmUnifiedFetch: (payload: {
        displayName: string;
        durationSec: number | null;
        metaArtist?: string;
        metaTitle?: string;
        metaAlbum?: string;
        sourceFileName?: string;
        altArtist?: string;
        altTitle?: string;
        playerHeaderLabel?: string;
      }) => Promise<unknown>;
      /** Desktop: one-shot Gemini lyrics + meaning JSON. */
      lyricsGeminiUnifiedFetch: (payload: {
        displayName: string;
        durationSec: number | null;
        metaArtist?: string;
        metaTitle?: string;
        metaAlbum?: string;
        sourceFileName?: string;
        altArtist?: string;
        altTitle?: string;
        playerHeaderLabel?: string;
      }) => Promise<unknown>;
      /** Desktop: LLM song meaning / interpretation from artist + title (file tags). */
      lyricsSongMeaningFetch: (payload: {
        artist: string;
        title: string;
        album?: string;
        displayName?: string;
        forceOpenAiCompatible?: boolean;
      }) => Promise<{
        ok: boolean;
        meaning?: string;
        error?: string;
        llmPurpose?: string;
        llmModel?: string;
        llmHost?: string;
      }>;
      /** Desktop: `[primaryOrigin, secondaryOrigin]` for /__proxy/stream (split view). */
      getStreamProxyOrigins: () => Promise<
        | string[]
        | {
            origins: string[];
            token?: string;
          }
      >;
      /** Desktop: sync File > Preferences > Enable split screen check state. */
      setSplitScreenPreference?: (enabled: boolean) => Promise<{ ok: true }>;
      /** Desktop: subscribe to File > Preferences > Enable split screen changes. */
      onSplitScreenPreferenceChange?: (callback: (enabled: boolean) => void) => () => void;
      pickRecordDir: () => Promise<string | null>;
      /** Desktop: pick a folder; main process recursively reads audio, audiobooks, and ebooks (`data: ArrayBuffer`). */
      pickLocalAudioFiles: () => Promise<
        Array<{
          /** Basename with extension; used with size/mtime for stable library + lyrics id (same as browser import). */
          fileName: string;
          name: string;
          size: number;
          lastModified: number;
          addedAt: number;
          mime: string;
          data: ArrayBuffer;
        }>
      >;
      pickLocalVideoFiles: () => Promise<Array<{ id: string; name: string; url: string; mime?: string }>>;
      prepareMkvPlayback: (
        fileUrl: string
      ) => Promise<{
        playUrl: string;
        mimeType?: string;
        playbackFormat?: "hls" | "mp4";
        usedTranscode: boolean;
        fromCache?: boolean;
        remuxed?: boolean;
        streaming?: boolean;
      }>;
      startStreamRecord: (payload: {
        url: string;
        outDir: string;
        filenameExt?: string;
        tapContentType?: string;
        recordMode?: "hls" | "mpegts" | "raw";
      }) => Promise<{
        ok: true;
        id: string;
        filePath: string;
        playbackUrl?: string | null;
      }>;
      stopStreamRecord: (id: string) => Promise<{ ok: boolean; filePath?: string }>;
      /** Desktop: Kokoro ONNX neural TTS voice list. */
      listNeuralTtsVoices: () => Promise<{
        ok: boolean;
        engine: string;
        model: string;
        modelCacheDir: string;
        audioCacheDir: string;
        piperVoicePacksDir?: string;
        voices: Array<{
          id: string;
          name: string;
          language: string;
          gender: string;
          accent: string;
          grade: string;
          engine?: "kokoro-js" | "piper-vits";
        }>;
      }>;
      /** Desktop: load the neural TTS model in the background before playback. */
      warmupNeuralTts: () => Promise<{
        ok: boolean;
        engine: string;
        model: string;
      }>;
      /** Desktop: synthesize one neural TTS chunk to a local WAV file. */
      synthesizeNeuralTts: (payload: {
        text: string;
        voice: string;
        speed?: number;
        style?: string;
        prefetch?: boolean;
      }) => Promise<{
        ok: boolean;
        canceled?: boolean;
        skipped?: boolean;
        reason?: string;
        engine?: string;
        cached?: boolean;
        path?: string;
        url?: string;
        durationMs?: number | null;
      }>;
      /** Desktop: cancel/supersede pending neural TTS synthesis. */
      cancelNeuralTts: () => Promise<{ ok: boolean }>;
      /** Desktop: local Whisper STT status for live radio captions. */
      whisperStatus: () => Promise<{
        modelKey: string;
        modelId: string;
        modelLabel?: string;
        downloadHint?: string;
        models?: Array<{ key: string; id: string; label: string; downloadHint: string }>;
        ready: boolean;
        loading: boolean;
        error: string | null;
      }>;
      /** Desktop: select Whisper variant (tiny | base | small). */
      whisperSetModel: (
        modelKey: string
      ) => Promise<{ ok: boolean; modelKey?: string; modelId?: string; error?: string }>;
      /** Desktop: load Whisper model (downloads on first use). */
      whisperWarmup: () => Promise<{
        ok: boolean;
        modelKey?: string;
        modelId?: string;
        error?: string;
      }>;
      /** Desktop: transcribe Float32 PCM @ 16 kHz (ArrayBuffer of float32 samples). */
      whisperTranscribePcm: (
        pcmArrayBuffer: ArrayBuffer
      ) => Promise<{ ok: boolean; text?: string; error?: string }>;
      /** Desktop: transcribe one MediaRecorder WebM chunk (legacy). */
      whisperTranscribeChunk: (
        audioWebm: ArrayBuffer
      ) => Promise<{ ok: boolean; text?: string; error?: string }>;
      /** Desktop: open File Explorer with this file selected. */
      showRecordInFolder: (filePath: string) => Promise<{ ok: true }>;
    };
  }
}

export {};
