/** Dispatched on `window` to open Settings → LLM API keys (see `App.tsx`). */
export const OPEN_LLM_SETTINGS_EVENT = "iptv-open-llm-settings";

export type LlmKeyKind = "any" | "gemini" | "compatible";

export const LLM_KEY_SETUP_HINT =
  "Add a DeepSeek, Gemini, or OpenAI API key in Settings to use LLM features.";

export interface OpenLlmSettingsDetail {
  welcome?: boolean;
  reason?: string;
}

export function isMissingLlmKeyMessage(msg: string | null | undefined): boolean {
  if (!msg?.trim()) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("iptv_lyrics_chat_translate_no_key") ||
    m.includes("iptv_gemini_no_key") ||
    m.includes("no api key") ||
    m.includes("add an llm api key") ||
    m.includes("add a gemini") ||
    m.includes("api key in settings") ||
    m.includes("llm needs the desktop app")
  );
}

export function isDesktopLlmAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.iptv?.getLyricsChatTranslateKeyStatus === "function";
}

/** Whether Settings / `.env` has the requested provider key. */
export async function hasLlmApiKeyFor(kind: LlmKeyKind): Promise<boolean> {
  const fn = window.iptv?.getLyricsChatTranslateKeyStatus;
  if (typeof fn !== "function") return false;
  try {
    const r = (await fn()) as {
      hasKey?: boolean;
      hasDeepSeekKey?: boolean;
      hasOpenAiKey?: boolean;
      hasGeminiKey?: boolean;
      hasSongMeaningKey?: boolean;
    };
    if (kind === "gemini") return !!r.hasGeminiKey;
    if (kind === "compatible") return !!(r.hasDeepSeekKey || r.hasOpenAiKey || r.hasKey);
    return !!(r.hasDeepSeekKey || r.hasGeminiKey || r.hasOpenAiKey || r.hasSongMeaningKey);
  } catch {
    return false;
  }
}

/** Open the app Settings modal on the LLM API keys section. */
export function promptLlmApiKeySetup(reason?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OpenLlmSettingsDetail>(OPEN_LLM_SETTINGS_EVENT, {
      detail: { welcome: true, reason },
    })
  );
}

/**
 * Returns true if the action may proceed. If a key is missing, opens Settings and returns false.
 */
export async function guardLlmApiKey(kind: LlmKeyKind, reason?: string): Promise<boolean> {
  if (!isDesktopLlmAvailable()) return false;
  if (await hasLlmApiKeyFor(kind)) return true;
  promptLlmApiKeySetup(reason);
  return false;
}
