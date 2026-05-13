export interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  /** From tvg-country / group-title heuristics (IPTV lists vary). */
  country?: string;
  /** IndexedDB key for local MP3 / audiobook resume (stable file fingerprint). */
  libraryTrackId?: string;
  /** MIME for local library playback (e.g. audio/mpeg); helps Chromium pick a decoder for blob URLs. */
  libraryContentType?: string;
}

export interface ParseResult {
  channels: Channel[];
  errors: string[];
}
