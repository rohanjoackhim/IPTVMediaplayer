import { myMemorySourceForFranc3 } from "./franc3ToMyMemorySource";

/**
 * LibreTranslate `source` field (ISO-ish). Derived from the same franc → map as MyMemory,
 * with small code fixes Libre expects (`zh`, `he`).
 */
export function libreTranslateSourceForFranc3(iso639_3: string): string | null {
  const m = myMemorySourceForFranc3(iso639_3);
  if (!m) return null;
  if (m === "zh-CN") return "zh";
  if (m === "iw") return "he";
  return m;
}
