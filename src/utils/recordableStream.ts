import { isLikelyHls, isLikelyMpegTsOverHttp } from "./streamKind";

export function isRadioStationChannelId(channelId: string): boolean {
  return channelId.startsWith("radio-");
}

/**
 * Raw HTTP dump matches continuous MPEG-TS for many IPTV panels.
 * HLS manifests would not produce a playable single file without transcoding.
 */
export function isLikelyRawTransportRecordable(url: string): boolean {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (isLikelyHls(u)) return false;
  return isLikelyMpegTsOverHttp(u);
}

/** One upstream → disk + tap: MPEG-TS IPTV or plain http(s) audio (e.g. Radio Browser). Not HLS. */
export function canRecordRawHttpStream(url: string, channelId: string): boolean {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (isLikelyHls(u)) return false;
  if (isLikelyRawTransportRecordable(u)) return true;
  if (isRadioStationChannelId(channelId)) return true;
  return false;
}

export interface RecordTapFileHint {
  filenameExt: string;
  tapContentType: string;
}

/** File suffix + tap MIME for Electron (tap must match bytes so browsers play while recording). */
export function recordFileSuffixAndTapType(url: string, channelId: string): RecordTapFileHint {
  const lower = url.toLowerCase();
  if (/\.aac(\?|#|$)/.test(lower)) return { filenameExt: ".aac", tapContentType: "audio/aac" };
  if (/\.mp3(\?|#|$)/.test(lower)) return { filenameExt: ".mp3", tapContentType: "audio/mpeg" };
  if (/\.ogg(\?|#|$)/.test(lower)) return { filenameExt: ".ogg", tapContentType: "audio/ogg" };
  if (/\.opus(\?|#|$)/.test(lower)) return { filenameExt: ".opus", tapContentType: "audio/ogg" };
  if (isRadioStationChannelId(channelId)) return { filenameExt: ".mp3", tapContentType: "audio/mpeg" };
  return { filenameExt: ".mpeg", tapContentType: "video/mp2t" };
}
