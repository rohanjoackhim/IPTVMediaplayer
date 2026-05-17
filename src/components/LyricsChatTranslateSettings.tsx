import { useCallback, useEffect, useState } from "react";
import "./LyricsChatTranslateSettings.css";

export function LyricsChatTranslateSettings() {
  const statusFn = window.iptv?.getLyricsChatTranslateKeyStatus;
  const saveFn = window.iptv?.setLyricsChatTranslateCredentials;
  if (typeof statusFn !== "function" || typeof saveFn !== "function") {
    return null;
  }

  const [hasKey, setHasKey] = useState(false);
  const [keyPreview, setKeyPreview] = useState("");
  const [keySource, setKeySource] = useState("");
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [geminiKeyPreview, setGeminiKeyPreview] = useState("");
  const [geminiKeySource, setGeminiKeySource] = useState("");
  const [geminiModelPreview, setGeminiModelPreview] = useState("");
  const [apiBasePreview, setApiBasePreview] = useState("");
  const [modelPreview, setModelPreview] = useState("");
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [geminiModelInput, setGeminiModelInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void statusFn().then((r) => {
      if (r && typeof r === "object") {
        const status = r as {
          hasKey: boolean;
          keyPreview?: string;
          keySource?: string;
          hasGeminiKey?: boolean;
          geminiKeyPreview?: string;
          geminiKeySource?: string;
          geminiModelPreview?: string;
          apiBasePreview?: string;
          modelPreview?: string;
        };
        setHasKey(!!status.hasKey);
        setKeyPreview(String(status.keyPreview ?? ""));
        setKeySource(String(status.keySource ?? ""));
        setHasGeminiKey(!!status.hasGeminiKey);
        setGeminiKeyPreview(String(status.geminiKeyPreview ?? ""));
        setGeminiKeySource(String(status.geminiKeySource ?? ""));
        setGeminiModelPreview(String(status.geminiModelPreview ?? ""));
        setApiBasePreview(String(status.apiBasePreview ?? ""));
        setModelPreview(String(status.modelPreview ?? ""));
      }
    });
  }, [statusFn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onSave = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = (await saveFn({
        key,
        baseUrl: baseUrlInput.trim(),
        model: modelInput.trim(),
      })) as {
        ok?: boolean;
        hasKey?: boolean;
        keyPreview?: string;
        keySource?: string;
        hasGeminiKey?: boolean;
        geminiKeyPreview?: string;
        geminiKeySource?: string;
        geminiModelPreview?: string;
        apiBasePreview?: string;
        modelPreview?: string;
      };
      applyStatus(r);
      setKeyInput("");
      setMsg(
        "Saved. Lyrics try this chat API first when a key is present, then public fallbacks (Google GTX, LibreTranslate, MyMemory). Defaults: https://api.deepseek.com and model deepseek-chat."
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyStatus = (r: {
    hasKey?: boolean;
    keyPreview?: string;
    keySource?: string;
    hasGeminiKey?: boolean;
    geminiKeyPreview?: string;
    geminiKeySource?: string;
    geminiModelPreview?: string;
    apiBasePreview?: string;
    modelPreview?: string;
  }) => {
    setHasKey(!!r?.hasKey);
    setKeyPreview(String(r?.keyPreview ?? ""));
    setKeySource(String(r?.keySource ?? ""));
    setHasGeminiKey(!!r?.hasGeminiKey);
    setGeminiKeyPreview(String(r?.geminiKeyPreview ?? ""));
    setGeminiKeySource(String(r?.geminiKeySource ?? ""));
    setGeminiModelPreview(String(r?.geminiModelPreview ?? ""));
    setApiBasePreview(String(r?.apiBasePreview ?? ""));
    setModelPreview(String(r?.modelPreview ?? ""));
  };

  const onSaveGemini = async () => {
    const geminiKey = geminiKeyInput.trim();
    if (!geminiKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await saveFn({
        geminiKey,
        geminiModel: geminiModelInput.trim(),
      });
      applyStatus(r);
      setGeminiKeyInput("");
      setMsg("Saved Gemini API key. Use Gemini lyrics to preview lyrics and meaning from Gemini.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onClearGemini = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await saveFn({ geminiKey: "", geminiModel: "" });
      applyStatus(r);
      setGeminiKeyInput("");
      setGeminiModelInput("");
      setMsg("Cleared saved Gemini credentials.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await saveFn({ key: "", baseUrl: "", model: "" })) as {
        hasKey?: boolean;
        keyPreview?: string;
        keySource?: string;
        hasGeminiKey?: boolean;
        geminiKeyPreview?: string;
        geminiKeySource?: string;
        geminiModelPreview?: string;
        apiBasePreview?: string;
        modelPreview?: string;
      };
      applyStatus(r);
      setKeyInput("");
      setBaseUrlInput("");
      setModelInput("");
      setMsg(
        "Cleared saved LLM credentials. You can still set DEEPSEEK_API_KEY, OPENAI_API_KEY, OPENAI_COMPATIBLE_LYRICS_API_KEY, OPENAI_COMPATIBLE_LYRICS_BASE_URL, or OPENAI_COMPATIBLE_LYRICS_MODEL for the desktop process."
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasAppSavedKey = keySource === "app";
  const hasAppSavedGeminiKey = geminiKeySource === "app";
  const hasAnyAppSavedKey = hasAppSavedKey || hasAppSavedGeminiKey;

  return (
    <div className="lyrics-chat-translate-settings">
      <button
        type="button"
        className={`lyrics-chat-translate-summary${hasAnyAppSavedKey ? " lyrics-chat-translate-summary--app-key" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={
          hasAnyAppSavedKey
            ? "Lyrics translation LLM settings, API key saved in app"
            : "Lyrics translation LLM settings"
        }
      >
        API
      </button>
      {open ? (
        <div className="lyrics-chat-translate-body">
          <div className="lyrics-chat-translate-provider-row" aria-label="Configured API providers">
            <button
              type="button"
              className={`lyrics-chat-translate-provider${hasKey ? " lyrics-chat-translate-provider--active" : ""}`}
              aria-pressed={hasKey}
              title={
                hasKey
                  ? `DeepSeek/OpenAI-compatible key active${keyPreview ? `: ${keyPreview}` : ""}${
                      keySource ? ` (${keySource === "app" ? "saved in app" : ".env"})` : ""
                    }${apiBasePreview ? ` · ${apiBasePreview}` : ""}${modelPreview ? ` · ${modelPreview}` : ""}`
                  : "No DeepSeek/OpenAI-compatible API key configured"
              }
            >
              DeepSeek
            </button>
            <button
              type="button"
              className={`lyrics-chat-translate-provider${hasGeminiKey ? " lyrics-chat-translate-provider--active" : ""}`}
              aria-pressed={hasGeminiKey}
              title={
                hasGeminiKey
                  ? `Gemini key active${geminiKeyPreview ? `: ${geminiKeyPreview}` : ""}${
                      geminiKeySource ? ` (${geminiKeySource === "app" ? "saved in app" : ".env"})` : ""
                    }${geminiModelPreview ? ` · ${geminiModelPreview}` : ""}`
                  : "No Gemini API key configured"
              }
            >
              Gemini
            </button>
          </div>
          <p className="lyrics-chat-translate-hint">
            Optional <strong>OpenAI-compatible</strong> API (<code className="lyrics-chat-translate-code">POST /v1/chat/completions</code>).
            On desktop, a <strong>project <code className="lyrics-chat-translate-code">.env</code></strong> file (see <code className="lyrics-chat-translate-code">.env.example</code>) can set <code className="lyrics-chat-translate-code">DEEPSEEK_API_KEY</code> (or similar). For <strong>song meaning only</strong>, you can alternatively set{" "}
            <code className="lyrics-chat-translate-code">GEMINI_API_KEY</code> from{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
              Google AI Studio
            </a>{" "}
            (Gemini) — lyrics features still use the OpenAI-compatible key below when provided. With a lyric key available, the app first tries one LLM request to find bilingual lyrics together; otherwise LRCLIB plus LLM line translation (then free translators). Defaults:{" "}
            <strong>DeepSeek</strong> (<code className="lyrics-chat-translate-code">https://api.deepseek.com</code>,{" "}
            <code className="lyrics-chat-translate-code">deepseek-chat</code>). OpenAI, OpenRouter, etc. work with the
            right base URL and model. LLM lyrics can be wrong — verify against official sources.
          </p>
          <div className="lyrics-chat-translate-row" style={{ marginBottom: 8 }}>
            <input
              type="url"
              autoComplete="off"
              spellCheck={false}
              className="lyrics-chat-translate-input"
              placeholder="API base URL (optional, default https://api.deepseek.com)"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
            />
          </div>
          <div className="lyrics-chat-translate-row" style={{ marginBottom: 8 }}>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="lyrics-chat-translate-input"
              placeholder="Model id (optional, default deepseek-chat)"
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
            />
          </div>
          <div className="lyrics-chat-translate-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="lyrics-chat-translate-input"
              placeholder="API key (Bearer)"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <button type="button" className="url-btn" disabled={busy || !keyInput.trim()} onClick={() => void onSave()}>
              Save
            </button>
            <button type="button" className="btn-ghost" disabled={busy || !hasAppSavedKey} onClick={() => void onClear()}>
              Clear saved
            </button>
          </div>
          {hasKey && keyPreview ? (
            <p className="lyrics-chat-translate-msg">
              Active API key: <code className="lyrics-chat-translate-code">{keyPreview}</code>
              {keySource ? ` (${keySource === "app" ? "saved in app" : ".env"})` : ""}
            </p>
          ) : null}
          <div className="lyrics-chat-translate-section-title">Google Gemini / AI Studio</div>
          <div className="lyrics-chat-translate-row" style={{ marginBottom: 8 }}>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              className="lyrics-chat-translate-input"
              placeholder="Gemini model (optional, default gemini-2.5-flash)"
              value={geminiModelInput}
              onChange={(e) => setGeminiModelInput(e.target.value)}
            />
          </div>
          <div className="lyrics-chat-translate-row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="lyrics-chat-translate-input"
              placeholder="Gemini API key"
              value={geminiKeyInput}
              onChange={(e) => setGeminiKeyInput(e.target.value)}
            />
            <button type="button" className="url-btn" disabled={busy || !geminiKeyInput.trim()} onClick={() => void onSaveGemini()}>
              Save Gemini
            </button>
            <button type="button" className="btn-ghost" disabled={busy || !hasAppSavedGeminiKey} onClick={() => void onClearGemini()}>
              Clear Gemini
            </button>
          </div>
          {hasGeminiKey && geminiKeyPreview ? (
            <p className="lyrics-chat-translate-msg">
              Active Gemini key: <code className="lyrics-chat-translate-code">{geminiKeyPreview}</code>
              {geminiKeySource ? ` (${geminiKeySource === "app" ? "saved in app" : ".env"})` : ""}
              {geminiModelPreview ? ` · ${geminiModelPreview}` : ""}
            </p>
          ) : null}
          {msg ? <p className="lyrics-chat-translate-msg">{msg}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
