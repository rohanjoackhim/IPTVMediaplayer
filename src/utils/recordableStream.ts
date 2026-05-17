import { isLikelyHls, isLikelyMpegTsOverHttp, isLikelyProgressiveVideoUrl } from "./streamKind";

export function isRadioStationChannelId(channelId: string): boolean {
  return channelId.startsWith("radio-");
}

/**
 * Raw HTTP dump matches continuous MPEG-TS for many IPTV panels.
 * HLS is recordable through the desktop FFmpeg path, not raw dumping.
 */
export function isLikelyRawTransportRecordable(url: string): boolean {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (isLikelyHls(u)) return false;
  return isLikelyMpegTsOverHttp(u);
}

/** Desktop recording supports HLS via FFmpeg plus direct http(s) media streams. */
export function canRecordRawHttpStream(url: string, channelId: string): boolean {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (isLikelyHls(u)) return true;
  if (isLikelyRawTransportRecordable(u)) return true;
  if (isLikelyProgressiveVideoUrl(u)) return true;
  if (isRadioStationChannelId(channelId)) return true;
  return true;
}

export interface RecordTapFileHint {
  filenameExt: string;
  tapContentType: string;
  recordMode: "hls" | "mpegts" | "raw";
}

/** File suffix + tap MIME for Electron (tap must match bytes so browsers play while recording). */
export function recordFileSuffixAndTapType(url: string, channelId: string): RecordTapFileHint {
  const lower = url.toLowerCase();
  if (isLikelyHls(url)) return { filenameExt: ".mp4", tapContentType: "application/octet-stream", recordMode: "hls" };
  if (/\.mp4(\?|#|$)/.test(lower)) return { filenameExt: ".mp4", tapContentType: "video/mp4", recordMode: "raw" };
  if (/\.m4v(\?|#|$)/.test(lower)) return { filenameExt: ".m4v", tapContentType: "video/mp4", recordMode: "raw" };
  if (/\.webm(\?|#|$)/.test(lower)) return { filenameExt: ".webm", tapContentType: "video/webm", recordMode: "raw" };
  if (/\.ogv(\?|#|$)/.test(lower)) return { filenameExt: ".ogv", tapContentType: "video/ogg", recordMode: "raw" };
  if (/\.mov(\?|#|$)/.test(lower)) return { filenameExt: ".mov", tapContentType: "video/quicktime", recordMode: "raw" };
  if (/\.aac(\?|#|$)/.test(lower)) return { filenameExt: ".aac", tapContentType: "audio/aac", recordMode: "raw" };
  if (/\.mp3(\?|#|$)/.test(lower)) return { filenameExt: ".mp3", tapContentType: "audio/mpeg", recordMode: "raw" };
  if (/\.ogg(\?|#|$)/.test(lower)) return { filenameExt: ".ogg", tapContentType: "audio/ogg", recordMode: "raw" };
  if (/\.opus(\?|#|$)/.test(lower)) return { filenameExt: ".opus", tapContentType: "audio/ogg", recordMode: "raw" };
  if (isRadioStationChannelId(channelId)) return { filenameExt: ".mp3", tapContentType: "audio/mpeg", recordMode: "raw" };
  if (isLikelyMpegTsOverHttp(url)) return { filenameExt: ".mp4", tapContentType: "video/mp2t", recordMode: "mpegts" };
  return { filenameExt: ".bin", tapContentType: "application/octet-stream", recordMode: "raw" };
}
