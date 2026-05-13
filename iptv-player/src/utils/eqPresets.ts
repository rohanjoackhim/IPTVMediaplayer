/** Ten-band graphic EQ center frequencies (Hz). */
export const EQ_BAND_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const EQ_BAND_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"] as const;

export type EqPresetId =
  | "flat"
  | "pop"
  | "rock"
  | "jazz"
  | "classical"
  | "country"
  | "electronic"
  | "bass"
  | "treble"
  | "custom";

/** dB per band (same order as EQ_BAND_HZ). */
export const EQ_PRESET_GAINS: Record<Exclude<EqPresetId, "custom">, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pop: [1, 2, 2, 0.5, -0.5, -1, 0, 1, 2, 2.5],
  rock: [4, 3, 2, 0, -0.5, 0.5, 2.5, 3.5, 4, 4],
  jazz: [2, 2, 1, 0, -0.5, -0.5, 0, 1, 2, 2],
  classical: [0, 0, 0, 0, 0, 0, 0.5, 1.5, 2, 2],
  country: [2, 1.5, 0, -0.5, 0, 1, 1.5, 1, 0.5, 1],
  electronic: [3, 2.5, 1, 0, -1, 0, 1, 2, 3, 3.5],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0.5],
  treble: [0, 0, 0, 0, 0, 0.5, 2, 3, 4, 5],
};

export const EQ_PRESET_ORDER: Exclude<EqPresetId, "custom">[] = [
  "flat",
  "pop",
  "rock",
  "jazz",
  "classical",
  "country",
  "electronic",
  "bass",
  "treble",
];

const EQ_PRESET_ID_SET = new Set<EqPresetId>([...EQ_PRESET_ORDER, "custom"]);

export function parseEqPresetId(raw: unknown): EqPresetId {
  if (typeof raw === "string" && EQ_PRESET_ID_SET.has(raw as EqPresetId)) return raw as EqPresetId;
  return "flat";
}

/** Normalized dB values per band for the Custom preset (same length as EQ_BAND_HZ). */
export function parseEqCustomGains(raw: unknown): number[] {
  const n = EQ_BAND_HZ.length;
  const zeros = (): number[] => Array.from({ length: n }, () => 0);
  if (!Array.isArray(raw)) return zeros();
  const out = raw.map((x) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(12, Math.max(-12, x)) : 0
  );
  while (out.length < n) out.push(0);
  return out.slice(0, n);
}

export const EQ_PRESET_DISPLAY: Record<EqPresetId, string> = {
  flat: "Flat",
  pop: "Pop",
  rock: "Rock",
  jazz: "Jazz",
  classical: "Classical",
  country: "Country",
  electronic: "Electronic",
  bass: "Bass boost",
  treble: "Treble boost",
  custom: "Custom",
};

export function gainsForPreset(preset: EqPresetId, customGains: readonly number[]): number[] {
  if (preset === "custom") {
    const out = [...customGains];
    while (out.length < EQ_BAND_HZ.length) out.push(0);
    return out.slice(0, EQ_BAND_HZ.length);
  }
  return [...EQ_PRESET_GAINS[preset]];
}
