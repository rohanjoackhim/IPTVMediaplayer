import { useEffect, useRef } from "react";
import { LlmApiSettings } from "./LyricsChatTranslateSettings";
import "./AppSettingsModal.css";

export interface AppSettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** First-run welcome copy (optional). */
  welcome?: boolean;
  /** Shown when opened from an LLM action that needs a key. */
  reason?: string | null;
  onDismissWelcome?: () => void;
}

export function AppSettingsModal({ open, onClose, welcome, reason, onDismissWelcome }: AppSettingsModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="app-settings-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="app-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
      >
        <header className="app-settings-header">
          <h2 id="app-settings-title">Settings</h2>
          <button type="button" className="app-settings-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        {welcome ? (
          <p className="app-settings-welcome">
            {reason ? (
              <>
                <strong>{reason}</strong> needs an API key. Add Gemini, DeepSeek, or OpenAI below — keys are stored
                locally on this computer and used for <strong>lyrics</strong>, <strong>translations</strong>,{" "}
                <strong>song meaning</strong>, and <strong>TV EPG (LLM)</strong>.
              </>
            ) : (
              <>
                Add API keys once here — they power <strong>lyrics</strong>, <strong>translations</strong>,{" "}
                <strong>song meaning</strong>, and <strong>TV EPG (LLM)</strong> across the app. Keys are stored locally
                on this computer.
              </>
            )}
          </p>
        ) : null}
        <div className="app-settings-body">
          <LlmApiSettings />
        </div>
        <footer className="app-settings-footer">
          {welcome && onDismissWelcome ? (
            <button type="button" className="btn-ghost" onClick={onDismissWelcome}>
              Skip for now
            </button>
          ) : null}
          <button type="button" className="url-btn" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
