/** Map ISO 639-3 (franc) → MyMemory `langpair` source segment (ISO 639-1 or vendor code). */
const FRANC3_TO_MYMEMORY: Record<string, string> = {
  eng: "",
  und: "",
  sco: "gd",
  afr: "af",
  ara: "ar",
  bul: "bg",
  ben: "bn",
  cat: "ca",
  zho: "zh-CN",
  hrv: "hr",
  ces: "cs",
  dan: "da",
  nld: "nl",
  est: "et",
  fin: "fi",
  fra: "fr",
  deu: "de",
  ell: "el",
  heb: "iw",
  hin: "hi",
  hun: "hu",
  ind: "id",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  lav: "lv",
  lit: "lt",
  msa: "ms",
  nor: "no",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rus: "ru",
  slk: "sk",
  slv: "sl",
  spa: "es",
  swe: "sv",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  vie: "vi",
};

/**
 * @returns MyMemory source code, or `null` if text is treated as English / unknown for translation.
 */
export function myMemorySourceForFranc3(iso639_3: string): string | null {
  const k = String(iso639_3 || "").trim().toLowerCase();
  if (!k || k === "und" || k === "eng") return null;
  return FRANC3_TO_MYMEMORY[k] ?? null;
}
