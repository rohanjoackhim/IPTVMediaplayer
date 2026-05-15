import { useEffect, useRef, useState } from "react";
import { TOP_LYRICS_TARGET_LANGUAGES } from "../utils/lyricsTargetLanguages";
import "./LyricsTranslateMenu.css";

export interface LyricsTranslateMenuProps {
  disabled?: boolean;
  busy?: boolean;
  activeTarget?: string | null;
  onSelectLanguage: (code: string) => void;
}

export function LyricsTranslateMenu({
  disabled,
  busy,
  activeTarget,
  onSelectLanguage,
}: LyricsTranslateMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="mp3-lyrics-translate-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`mp3-lyrics-translate-btn${open ? " mp3-lyrics-translate-btn--open" : ""}`}
        disabled={disabled || busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Translate lyrics to another language"
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? "Translating…" : "Translate ▾"}
      </button>
      {open && !busy ? (
        <ul className="mp3-lyrics-translate-menu" role="listbox" aria-label="Target language">
          {TOP_LYRICS_TARGET_LANGUAGES.map((lang) => (
            <li key={lang.code} role="option" aria-selected={activeTarget === lang.code}>
              <button
                type="button"
                className={`mp3-lyrics-translate-option${activeTarget === lang.code ? " mp3-lyrics-translate-option--active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  onSelectLanguage(lang.code);
                }}
              >
                <span className="mp3-lyrics-translate-option-label">{lang.label}</span>
                {lang.nativeLabel ? (
                  <span className="mp3-lyrics-translate-option-native">{lang.nativeLabel}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
