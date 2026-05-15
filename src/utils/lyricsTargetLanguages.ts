/** Top ~20 languages by global use — ISO 639-1 codes for lyric translation targets. */
export interface LyricsTargetLanguage {
  code: string;
  label: string;
  nativeLabel?: string;
}

export const TOP_LYRICS_TARGET_LANGUAGES: LyricsTargetLanguage[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese (Simplified)", nativeLabel: "简体中文" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية" },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português" },
  { code: "ru", label: "Russian", nativeLabel: "Русский" },
  { code: "ur", label: "Urdu", nativeLabel: "اردو" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "vi", label: "Vietnamese", nativeLabel: "Tiếng Việt" },
  { code: "it", label: "Italian", nativeLabel: "Italiano" },
  { code: "pl", label: "Polish", nativeLabel: "Polski" },
  { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
  { code: "th", label: "Thai", nativeLabel: "ไทย" },
];

const ISO639_1_TO_MYMEMORY: Record<string, string> = {
  zh: "zh-CN",
  he: "iw",
};

export function myMemoryCodeForIso639_1(code: string): string {
  const c = code.trim().toLowerCase();
  return ISO639_1_TO_MYMEMORY[c] ?? c;
}

export function labelForLyricsTargetCode(code: string): string {
  const hit = TOP_LYRICS_TARGET_LANGUAGES.find((l) => l.code === code);
  if (!hit) return code;
  return hit.nativeLabel ? `${hit.label} (${hit.nativeLabel})` : hit.label;
}
