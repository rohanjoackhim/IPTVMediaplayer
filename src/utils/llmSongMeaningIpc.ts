export interface SongMeaningRequest {
  artist: string;
  title: string;
  album?: string;
  displayName?: string;
  forceOpenAiCompatible?: boolean;
}

export interface SongMeaningResult {
  ok: boolean;
  meaning: string;
  error?: string;
  llmPurpose?: string;
  llmModel?: string;
  llmHost?: string;
}

function readLlmMeta(o: Record<string, unknown>): Pick<SongMeaningResult, "llmPurpose" | "llmModel" | "llmHost"> {
  return {
    llmPurpose: typeof o.llmPurpose === "string" ? o.llmPurpose.trim() : undefined,
    llmModel: typeof o.llmModel === "string" ? o.llmModel.trim() : undefined,
    llmHost: typeof o.llmHost === "string" ? o.llmHost.trim() : undefined,
  };
}

/**
 * Desktop: ask the configured LLM what the song is about (same API key as lyrics translation).
 */
export async function fetchSongMeaningFromLlm(
  req: SongMeaningRequest,
  signal?: AbortSignal
): Promise<SongMeaningResult> {
  const ipc = typeof window !== "undefined" ? window.iptv?.lyricsSongMeaningFetch : undefined;
  if (typeof ipc !== "function") {
    return { ok: false, meaning: "", error: "Song meaning needs the desktop app. Add an LLM API key in Settings." };
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let raw: unknown;
  try {
    raw = await ipc({
      artist: req.artist.trim(),
      title: req.title.trim(),
      album: req.album?.trim() || undefined,
      displayName: req.displayName?.trim() || undefined,
      forceOpenAiCompatible: req.forceOpenAiCompatible === true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) {
      return {
        ok: false,
        meaning: "",
        error: "Add an LLM API key in Settings (DeepSeek, Gemini, or OpenAI).",
      };
    }
    return { ok: false, meaning: "", error: msg || "LLM request failed." };
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, meaning: "", error: "Invalid response from LLM." };
  }
  const o = raw as Record<string, unknown>;
  const meta = readLlmMeta(o);
  const ok = o.ok === true;
  const meaning = typeof o.meaning === "string" ? o.meaning.trim() : "";
  const error = typeof o.error === "string" ? o.error.trim() : "";
  if (ok && meaning) return { ok: true, meaning, ...meta };
  return { ok: false, meaning: "", error: error || "No explanation returned.", ...meta };
}
