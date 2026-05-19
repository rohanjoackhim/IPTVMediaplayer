/// <reference types="vite/client" />

declare global {
  interface Window {
    /** Exposed by Electron `preload.cjs`. */
    iptv?: {
      fetchPlaylistText: (url: string) => Promise<string>;
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
        /** True if OpenAI-compatible env/settings key OR `GEMINI_*` in main `.env` (song meaning). */
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
      }) => Promise<unknown>;
      /** Desktop: one-shot Gemini lyrics + meaning JSON. */
      lyricsGeminiUnifiedFetch: (payload: {
        displayName: string;
        durationSec: number | null;
        metaArtist?: string;
        metaTitle?: string;
        metaAlbum?: string;
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
        usedTranscode: boolean;
        fromCache?: boolean;
        remuxed?: boolean;
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
      /** Desktop: open File Explorer with this file selected. */
      showRecordInFolder: (filePath: string) => Promise<{ ok: true }>;
    };
  }
}

export {};
