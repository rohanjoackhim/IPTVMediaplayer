/** Persisted key for local Xenova Whisper STT (live radio/podcast captions). */
export type LiveCaptionsSttModelId = "tiny" | "base" | "small";

export interface LiveCaptionsSttModelOption {
  id: LiveCaptionsSttModelId;
  label: string;
  hint: string;
  downloadHint: string;
}

export const LIVE_CAPTIONS_STT_MODELS: readonly LiveCaptionsSttModelOption[] = [
  { id: "tiny", label: "Tiny", hint: "Fastest, lowest accuracy", downloadHint: "~75 MB" },
  { id: "base", label: "Base", hint: "Balanced speed and quality", downloadHint: "~150 MB" },
  { id: "small", label: "Small", hint: "Best accuracy, slower", downloadHint: "~460 MB" },
] as const;

export const DEFAULT_LIVE_CAPTIONS_STT_MODEL: LiveCaptionsSttModelId = "tiny";

export function parseLiveCaptionsSttModel(raw: unknown): LiveCaptionsSttModelId {
  if (raw === "base" || raw === "small" || raw === "tiny") return raw;
  return DEFAULT_LIVE_CAPTIONS_STT_MODEL;
}

export function liveCaptionsSttModelLabel(id: LiveCaptionsSttModelId): string {
  return LIVE_CAPTIONS_STT_MODELS.find((m) => m.id === id)?.label ?? "Tiny";
}

export function liveCaptionsSttDownloadHint(id: LiveCaptionsSttModelId): string {
  return LIVE_CAPTIONS_STT_MODELS.find((m) => m.id === id)?.downloadHint ?? "~75 MB";
}
