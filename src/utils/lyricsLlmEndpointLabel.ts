export interface LyricsLlmEndpointInfo {
  model: string;
  host: string;
  label: string;
}

const DEFAULT: LyricsLlmEndpointInfo = {
  model: "deepseek-chat",
  host: "api.deepseek.com",
  label: "deepseek-chat @ api.deepseek.com",
};

function stripDefaultSuffix(s: string): string {
  return s.replace(/\s*\(default\)\s*$/i, "").trim();
}

/** Configured OpenAI-compatible endpoint from desktop Settings (never includes the API key). */
export async function fetchLyricsLlmEndpointInfo(): Promise<LyricsLlmEndpointInfo> {
  const fn = typeof window !== "undefined" ? window.iptv?.getLyricsChatTranslateKeyStatus : undefined;
  if (typeof fn !== "function") return { ...DEFAULT };
  try {
    const r = (await fn()) as { apiBasePreview?: string; modelPreview?: string };
    const host = stripDefaultSuffix(String(r.apiBasePreview ?? "").trim()) || DEFAULT.host;
    const model = stripDefaultSuffix(String(r.modelPreview ?? "").trim()) || DEFAULT.model;
    return { model, host, label: `${model} @ ${host}` };
  } catch {
    return { ...DEFAULT };
  }
}

export function formatLlmUsageLine(purpose: string, model: string, host: string): string {
  return `${purpose}: ${model} @ ${host}`;
}

/** Desktop: whether `.env` / Settings provides an LLM key (lyrics + meaning). */
export async function hasLyricsLlmKey(): Promise<boolean> {
  const fn = typeof window !== "undefined" ? window.iptv?.getLyricsChatTranslateKeyStatus : undefined;
  if (typeof fn !== "function") return false;
  try {
    const r = (await fn()) as { hasKey?: boolean };
    return !!r.hasKey;
  } catch {
    return false;
  }
}

/** Desktop: any provider for song meaning — OpenAI-compatible (`DEEPSEEK_*`, etc.) or `GEMINI_*` in `.env`. */
export async function hasSongMeaningKey(): Promise<boolean> {
  const fn = typeof window !== "undefined" ? window.iptv?.getLyricsChatTranslateKeyStatus : undefined;
  if (typeof fn !== "function") return false;
  try {
    const r = (await fn()) as { hasSongMeaningKey?: boolean; hasKey?: boolean };
    if (typeof r.hasSongMeaningKey === "boolean") return r.hasSongMeaningKey;
    return !!r.hasKey;
  } catch {
    return false;
  }
}
