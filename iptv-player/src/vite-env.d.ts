/// <reference types="vite/client" />

declare global {
  interface Window {
    /** Exposed by Electron `preload.cjs`. */
    iptv?: {
      fetchPlaylistText: (url: string) => Promise<string>;
      /** Desktop: `[primaryOrigin, secondaryOrigin]` for /__proxy/stream (split view). */
      getStreamProxyOrigins: () => Promise<string[]>;
      pickRecordDir: () => Promise<string | null>;
      /** Desktop: native picker + read in main; each item has `data: ArrayBuffer`. */
      pickLocalAudioFiles: () => Promise<
        Array<{
          id: string;
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
