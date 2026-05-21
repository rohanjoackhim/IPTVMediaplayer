import type { LiveCaptionsSttModelId } from "./liveCaptionsSttModels";

/** Tell the Electron main process which Xenova Whisper model to load. */
export async function applyLiveCaptionsSttModel(
  model: LiveCaptionsSttModelId
): Promise<{ ok: boolean; error?: string }> {
  if (!window.iptv?.whisperSetModel) return { ok: true };
  return window.iptv.whisperSetModel(model);
}
