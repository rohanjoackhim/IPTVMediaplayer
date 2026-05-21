import { useCallback, useEffect, useState } from "react";
import "./LyricsChatTranslateSettings.css";

const PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
} as const;

type ProviderPreset = keyof typeof PRESETS;

/** LLM API keys for lyrics, translation, song meaning, and TV EPG (desktop). */
export function LlmApiSettings() {
  const statusFn = window.iptv?.getLyricsChatTranslateKeyStatus;
  const saveFn = window.iptv?.setLyricsChatTranslateCredentials;
  if (typeof statusFn !== "function" || typeof saveFn !== "function") {
    return (
      <p className="lyrics-chat-translate-hint">
        LLM API keys are available in the <strong>desktop app</strong> (Electron). In the browser build, lyrics and EPG
        use free fallbacks only.
      </p>
    );
  }

  const [hasKey, setHasKey] = useState(false);
  const [hasDeepSeekKey, setHasDeepSeekKey] = useState(false);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [keyPreview, setKeyPreview] = useState("");
  const [keySource, setKeySource] = useState("");
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [geminiKeyPreview, setGeminiKeyPreview] = useState("");
  const [geminiKeySource, setGeminiKeySource] = useState("");
  const [geminiModelPreview, setGeminiModelPreview] = useState("");
  const [apiBasePreview, setApiBasePreview] = useState("");
  const [modelPreview, setModelPreview] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [geminiModelInput, setGeminiModelInput] = useState("");
  const [activePreset, setActivePreset] = useState<ProviderPreset>("deepseek");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void statusFn().then((r) => {
      if (r && typeof r === "object") {
        const status = r as {
          hasKey: boolean;
          hasDeepSeekKey?: boolean;
          hasOpenAiKey?: boolean;
          primaryLlmProvider?: string;
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
        setHasDeepSeekKey(!!status.hasDeepSeekKey);
        setHasOpenAiKey(!!status.hasOpenAiKey);
        setKeyPreview(String(status.keyPreview ?? ""));
        setKeySource(String(status.keySource ?? ""));
        setHasGeminiKey(!!status.hasGeminiKey);
        setGeminiKeyPreview(String(status.geminiKeyPreview ?? ""));
        setGeminiKeySource(String(status.geminiKeySource ?? ""));
        setGeminiModelPreview(String(status.geminiModelPreview ?? ""));
        setApiBasePreview(String(status.apiBasePreview ?? ""));
        setModelPreview(String(status.modelPreview ?? ""));
        const primary = String(status.primaryLlmProvider ?? "").toLowerCase();
        if (primary === "openai") setActivePreset("openai");
        else if (primary === "deepseek") setActivePreset("deepseek");
        else {
          const host = String(status.apiBasePreview ?? "").toLowerCase();
          if (host.includes("openai.com")) setActivePreset("openai");
          else if (host.includes("deepseek")) setActivePreset("deepseek");
        }
      }
    });
  }, [statusFn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const applyPreset = (preset: ProviderPreset) => {
    setActivePreset(preset);
    const p = PRESETS[preset];
    setBaseUrlInput(p.baseUrl);
    setModelInput(p.model);
  };

  const onSaveCompatible = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = (await saveFn({
        key,
        baseUrl: baseUrlInput.trim() || PRESETS[activePreset].baseUrl,
        model: modelInput.trim() || PRESETS[activePreset].model,
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
        `Saved ${PRESETS[activePreset].label} key. Used for lyrics, translations, song meaning, and TV EPG (LLM).`
      );
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
      setMsg("Saved Gemini key. Used for lyrics, song meaning, and TV EPG when Gemini is selected.");
      refresh();
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
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onClearCompatible = async () => {
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
      setMsg("Cleared saved DeepSeek/OpenAI-compatible credentials.");
      refresh();
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
    <div
      className={`lyrics-chat-translate-settings${hasAnyAppSavedKey ? " lyrics-chat-translate-settings--keys-saved" : ""}`}
    >
      <div className="lyrics-chat-translate-body">
        <p className="lyrics-chat-translate-lead">
          One place for all <strong>LLM API keys</strong> in this app: bilingual lyrics, line translation, song meaning,
          live radio caption translation, and <strong>TV program guide (EPG)</strong> via LLM.
        </p>
        <div className="lyrics-chat-translate-provider-row" aria-label="Configured API providers">
          <button
            type="button"
            className={`lyrics-chat-translate-provider${hasDeepSeekKey ? " lyrics-chat-translate-provider--active" : ""}`}
            title="DeepSeek — used first for automatic LLM"
          >
            DeepSeek{hasDeepSeekKey ? " ✓" : ""}
          </button>
          <button
            type="button"
            className={`lyrics-chat-translate-provider${hasGeminiKey ? " lyrics-chat-translate-provider--active" : ""}`}
            title={
              hasGeminiKey
                ? `Gemini${geminiKeyPreview ? `: ${geminiKeyPreview}` : ""}${
                    geminiModelPreview ? ` · ${geminiModelPreview}` : ""}`
                : "No Gemini key"
            }
          >
            Gemini{hasGeminiKey ? " ✓" : ""}
          </button>
          <button
            type="button"
            className={`lyrics-chat-translate-provider${hasOpenAiKey ? " lyrics-chat-translate-provider--active" : ""}`}
            title="OpenAI — used after DeepSeek and Gemini"
          >
            OpenAI{hasOpenAiKey ? " ✓" : ""}
          </button>
        </div>

        <div className="lyrics-chat-translate-section-title">DeepSeek or OpenAI (chat API key)</div>
        <p className="lyrics-chat-translate-hint">
          Automatic LLM tries <strong>DeepSeek</strong>, then <strong>Gemini</strong>, then <strong>OpenAI</strong>.
          Uses <code className="lyrics-chat-translate-code">POST /v1/chat/completions</code>.
        </p>
        <div className="lyrics-chat-translate-preset-row" role="group" aria-label="API provider preset">
          {(Object.keys(PRESETS) as ProviderPreset[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`lyrics-chat-translate-preset${activePreset === id ? " lyrics-chat-translate-preset--active" : ""}`}
              onClick={() => applyPreset(id)}
            >
              {PRESETS[id].label}
            </button>
          ))}
        </div>
        <div className="lyrics-chat-translate-row" style={{ marginBottom: 8 }}>
          <input
            type="url"
            autoComplete="off"
            spellCheck={false}
            className="lyrics-chat-translate-input"
            placeholder={`API base URL (${PRESETS[activePreset].baseUrl})`}
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
            placeholder={`Model (${PRESETS[activePreset].model})`}
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
            placeholder={`${PRESETS[activePreset].label} API key`}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button
            type="button"
            className="url-btn"
            disabled={busy || !keyInput.trim()}
            onClick={() => void onSaveCompatible()}
          >
            Save
          </button>
          <button type="button" className="btn-ghost" disabled={busy || !hasAppSavedKey} onClick={() => void onClearCompatible()}>
            Clear
          </button>
        </div>
        {hasKey && keyPreview ? (
          <p className="lyrics-chat-translate-msg">
            Active key: <code className="lyrics-chat-translate-code">{keyPreview}</code>
            {keySource ? ` (${keySource === "app" ? "saved in Settings" : ".env"})` : ""}
            {apiBasePreview ? ` · ${apiBasePreview}` : ""}
            {modelPreview ? ` · ${modelPreview}` : ""}
          </p>
        ) : null}

        <div className="lyrics-chat-translate-section-title">Gemini (Google AI Studio)</div>
        <p className="lyrics-chat-translate-hint">
          Get a key from{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
            Google AI Studio
          </a>
          . Optional if you already use DeepSeek/OpenAI above.
        </p>
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
            Save
          </button>
          <button type="button" className="btn-ghost" disabled={busy || !hasAppSavedGeminiKey} onClick={() => void onClearGemini()}>
            Clear
          </button>
        </div>
        {hasGeminiKey && geminiKeyPreview ? (
          <p className="lyrics-chat-translate-msg">
            Active Gemini key: <code className="lyrics-chat-translate-code">{geminiKeyPreview}</code>
            {geminiKeySource ? ` (${geminiKeySource === "app" ? "saved in Settings" : ".env"})` : ""}
            {geminiModelPreview ? ` · ${geminiModelPreview}` : ""}
          </p>
        ) : null}
        {msg ? <p className="lyrics-chat-translate-msg">{msg}</p> : null}
      </div>
    </div>
  );
}

/** @deprecated Use `LlmApiSettings` — kept for existing imports. */
export const LyricsChatTranslateSettings = LlmApiSettings;
