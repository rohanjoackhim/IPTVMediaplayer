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
  /** MIME hint for local playback (`<source type>`): audio library, or desktop-picked video (AVI/MKV/MPEG, etc.). */
  libraryContentType?: string;
  /** Television: video picked from disk (`file://` in desktop app) or browser (`blob:`); use split view to play alongside IPTV. */
  localVideoFile?: boolean;
  /** Original file name with extension (browser picks); used to detect MKV for FFmpeg vs native path. */
  localOriginalFileName?: string;
}

export interface ParseResult {
  channels: Channel[];
  errors: string[];
}
