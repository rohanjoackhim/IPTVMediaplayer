export interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  /** XMLTV channel id from M3U `tvg-id` (links to EPG). */
  tvgId?: string;
  /** From tvg-country / group-title heuristics (IPTV lists vary). */
  country?: string;
  /** Online radio metadata from Radio Browser. */
  radioTags?: string;
  radioHomepage?: string;
  radioCodec?: string;
  radioBitrate?: number;
  /** Podcast episode/show metadata from the podcast directory. */
  podcastShowName?: string;
  podcastAuthor?: string;
  podcastGenre?: string;
  podcastReleaseDate?: string;
  podcastDurationMs?: number;
  podcastDescription?: string;
  /** IndexedDB key for local MP3 / audiobook resume (stable file fingerprint). */
  libraryTrackId?: string;
  /** Set when restarting the same library blob so effect teardown skips re-saving resume. */
  libraryRestartNonce?: number;
  /** Bumped by the Television reset button to reconnect the same stream URL. */
  streamResetNonce?: number;
  /** MIME hint for local playback (`<source type>`): audio library, or desktop-picked video (AVI/MKV/MPEG, etc.). */
  libraryContentType?: string;
  /** Television: video picked from disk (`file://` in desktop app) or browser (`blob:`); use split view to play alongside IPTV. */
  localVideoFile?: boolean;
  /** Television: YouTube URL added by the user; played via YouTube embed. */
  youtubeVideoId?: string;
  /** Television: website video page added by the user; played in an embedded frame when the site permits it. */
  webVideoPageUrl?: string;
  /** Original file name with extension (browser picks); used to detect MKV for FFmpeg vs native path. */
  localOriginalFileName?: string;
  /** Local ebook row selected from the Audio tab; displayed/read in the player pane. */
  ebookId?: string;
  ebookText?: string;
  ebookFormat?: "pdf" | "epub" | "html" | "text";
  ebookBlob?: Blob;
  ebookPages?: string[];
  ebookSourceFileName?: string;
  ebookStartChunk?: number;
}

export interface ParseResult {
  channels: Channel[];
  errors: string[];
}
