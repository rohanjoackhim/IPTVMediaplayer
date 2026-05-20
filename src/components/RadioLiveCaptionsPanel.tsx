import { useEffect, useRef } from "react";
import { LyricsTranslateMenu } from "./LyricsTranslateMenu";
import type { RadioCaptionSegment } from "../utils/radioLiveCaptions";
import "./RadioLiveCaptionsPanel.css";

export interface RadioLiveCaptionsPanelProps {
  /** Side-by-side radio layout: captions fill the full right column height. */
  layout?: "default" | "split";
  enabled: boolean;
  status: string;
  error: string | null;
  segments: RadioCaptionSegment[];
  translateBusy?: boolean;
  translateTarget?: string | null;
  translateHint?: string | null;
  translateErr?: string | null;
  onToggle: () => void;
  onClear: () => void;
  onSelectTranslateLanguage: (code: string) => void;
}

export function RadioLiveCaptionsPanel({
  layout = "default",
  enabled,
  status,
  error,
  segments,
  translateBusy,
  translateTarget,
  translateHint,
  translateErr,
  onToggle,
  onClear,
  onSelectTranslateLanguage,
}: RadioLiveCaptionsPanelProps) {
  const hasText = segments.some((s) => s.text.trim());
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [segments]);

  const isSplit = layout === "split";
  const showCaptionBody = enabled || hasText;

  return (
    <section
      className={`radio-live-captions${enabled ? " radio-live-captions--active" : ""}${
        showCaptionBody ? " radio-live-captions--has-content" : ""
      }${isSplit ? " radio-live-captions--split" : ""}`}
      aria-label="Live radio captions"
    >
      <div className="radio-live-captions-head">
        <span className="radio-live-captions-title">Live captions</span>
        <div className="radio-live-captions-actions">
          {hasText ? (
            <LyricsTranslateMenu
              disabled={!hasText}
              busy={translateBusy}
              activeTarget={translateTarget}
              onSelectLanguage={onSelectTranslateLanguage}
            />
          ) : null}
          {hasText ? (
            <button type="button" className="radio-live-captions-clear" onClick={onClear}>
              Clear
            </button>
          ) : null}
          <button
            type="button"
            className={`radio-live-captions-toggle${enabled ? " radio-live-captions-toggle--on" : ""}`}
            aria-pressed={enabled}
            onClick={onToggle}
          >
            {enabled ? "Stop captions" : "Start captions"}
          </button>
        </div>
      </div>
      <div className="radio-live-captions-fill">
        {showCaptionBody ? (
          <>
            {enabled && status ? <p className="radio-live-captions-status">{status}</p> : null}
            {!enabled && hasText ? (
              <p className="radio-live-captions-status radio-live-captions-status--paused">Captions paused</p>
            ) : null}
            {error ? (
            <p className="radio-live-captions-err" role="alert">
              {error}
            </p>
          ) : null}
          {translateErr ? (
            <p className="radio-live-captions-err" role="alert">
              {translateErr}
            </p>
          ) : null}
          {translateHint ? <p className="radio-live-captions-hint">{translateHint}</p> : null}
          <div ref={bodyRef} className="radio-live-captions-body" aria-live="polite">
            {!hasText && enabled && !error ? (
              <p className="radio-live-captions-empty">No captions yet.</p>
            ) : (
              segments.map((seg) => (
                <div key={seg.id} className="radio-live-captions-line">
                  <p className="radio-live-captions-text">{seg.text}</p>
                  {seg.translated && seg.translated !== seg.text ? (
                    <p className="radio-live-captions-translated">{seg.translated}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
          </>
        ) : (
          <div className="radio-live-captions-body radio-live-captions-body--idle">
            <p className="radio-live-captions-hint radio-live-captions-hint--idle">
              Local Whisper — near real-time (~2–4 s behind speech). Best for talk and news. First run may download the
              model once.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
