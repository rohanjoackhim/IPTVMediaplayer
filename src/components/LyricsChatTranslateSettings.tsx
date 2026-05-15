import { useCallback, useEffect, useState } from "react";
import "./LyricsChatTranslateSettings.css";

export function LyricsChatTranslateSettings() {
  const statusFn = window.iptv?.getLyricsChatTranslateKeyStatus;
  const saveFn = window.iptv?.setLyricsChatTranslateCredentials;
  if (typeof statusFn !== "function" || typeof saveFn !== "function") {
    return null;
  }

  const [hasKey, setHasKey] = useState(false);
  const [apiBasePreview, setApiBasePreview] = useState("");
  const [modelPreview, setModelPreview] = useState("");
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void statusFn().then((r) => {
      if (r && typeof r === "object") {
        setHasKey(!!(r as { hasKey: boolean }).hasKey);
        setApiBasePreview(String((r as { apiBasePreview?: string }).apiBasePreview ?? ""));
        setModelPreview(String((r as { modelPreview?: string }).modelPreview ?? ""));
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
      })) as { ok?: boolean; hasKey?: boolean; apiBasePreview?: string; modelPreview?: string };
      setHasKey(!!r?.hasKey);
      setApiBasePreview(String(r?.apiBasePreview ?? ""));
      setModelPreview(String(r?.modelPreview ?? ""));
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

  const onClear = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await saveFn({ key: "", baseUrl: "", model: "" });
      setHasKey(false);
      setApiBasePreview("");
      setModelPreview("");
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

  return (
    <div className="lyrics-chat-translate-settings">
      <button
        type="button"
        className="lyrics-chat-translate-summary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Lyrics translation — LLM (DeepSeek / OpenAI-compatible){" "}
        <span className="lyrics-chat-translate-badge">{hasKey ? "on" : "off"}</span>
        {hasKey && apiBasePreview ? (
          <span className="lyrics-chat-translate-preview" title="Configured API host and model">
            {" "}
            ({apiBasePreview} · {modelPreview})
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="lyrics-chat-translate-body">
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
            <button type="button" className="btn-ghost" disabled={busy || !hasKey} onClick={() => void onClear()}>
              Clear saved
            </button>
          </div>
          {msg ? <p className="lyrics-chat-translate-msg">{msg}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
