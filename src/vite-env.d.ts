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
        apiBasePreview: string;
        modelPreview: string;
      }>;
      setLyricsChatTranslateCredentials: (payload: {
        key: string;
        baseUrl?: string;
        model?: string;
      }) => Promise<{ ok: boolean; hasKey: boolean; apiBasePreview: string; modelPreview: string }>;
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
      /** Desktop: LLM song meaning / interpretation from artist + title (file tags). */
      lyricsSongMeaningFetch: (payload: {
        artist: string;
        title: string;
        album?: string;
        displayName?: string;
      }) => Promise<{
        ok: boolean;
        meaning?: string;
        error?: string;
        llmPurpose?: string;
        llmModel?: string;
        llmHost?: string;
      }>;
      /** Desktop: `[primaryOrigin, secondaryOrigin]` for /__proxy/stream (split view). */
      getStreamProxyOrigins: () => Promise<string[]>;
      pickRecordDir: () => Promise<string | null>;
      /** Desktop: native picker + read in main; each item has `data: ArrayBuffer`. */
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
      }) => Promise<{
        ok: true;
        id: string;
        filePath: string;
        playbackUrl?: string | null;
      }>;
      stopStreamRecord: (id: string) => Promise<{ ok: boolean; filePath?: string }>;
      /** Desktop: open File Explorer with this file selected. */
      showRecordInFolder: (filePath: string) => Promise<{ ok: true }>;
    };
  }
}

export {};
