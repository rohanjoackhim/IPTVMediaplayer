import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  EQ_BAND_LABELS,
  EQ_PRESET_DISPLAY,
  EQ_PRESET_ORDER,
  gainsForPreset,
  type EqPresetId,
} from "../utils/eqPresets";
import {
  applyElementEqPreset,
  disableElementEq,
  handoffEqScope,
  isEqFilterGraphActive,
  resumeEqContextForPlayback,
  resumeEqContextFromGesture,
  setEqMasterGain,
  updateElementEqLive,
} from "../utils/eqAudioGraph";
import {
  loadEqSettingsForScope,
  saveEqSettingsForScope,
  type EqPageScope,
} from "../utils/eqScopeSettings";
import { AnchoredPopover } from "./AnchoredPopover";
import "./RadioEqualizer.css";

const EQ_PRESET_SHORT: Record<EqPresetId, string> = {
  flat: "Flat",
  pop: "Pop",
  rock: "Rock",
  jazz: "Jazz",
  classical: "Class",
  country: "Ctry",
  electronic: "Elec",
  bass: "Bass",
  treble: "Tre",
  custom: "Cust",
};

export interface RadioEqualizerProps {
  mediaRef: RefObject<HTMLVideoElement | null>;
  eqEnabled: boolean;
  eqScope: EqPageScope;
  volume: number;
  streamKey?: string;
  onEqActiveChange?: (active: boolean) => void;
  /** Portal + viewport flip (library player chrome at bottom of the screen). */
  anchoredPopover?: boolean;
}

export function RadioEqualizer({
  mediaRef,
  eqEnabled,
  eqScope,
  volume,
  streamKey,
  onEqActiveChange,
  anchoredPopover = false,
}: RadioEqualizerProps) {
  const uid = useId();
  const triggerId = `radio-eq-trigger-${uid}`;
  const panelId = `radio-eq-panel-${uid}`;
  const presetId = `radio-eq-preset-${uid}`;
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchoredPanelRef = useRef<HTMLDivElement>(null);

  const persistedEq = useMemo(() => loadEqSettingsForScope(eqScope), [eqScope]);

  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<EqPresetId>(persistedEq.preset);
  const [customGains, setCustomGains] = useState<number[]>(persistedEq.customGains);
  const [eqErr, setEqErr] = useState<string | null>(null);
  const [eqActive, setEqActive] = useState(false);
  const busyRef = useRef(false);
  const ensureEqGenRef = useRef(0);
  const presetRef = useRef(preset);
  const customRef = useRef(customGains);
  const volumeRef = useRef(volume);
  const onActiveRef = useRef(onEqActiveChange);
  presetRef.current = preset;
  customRef.current = customGains;
  volumeRef.current = volume;
  onActiveRef.current = onEqActiveChange;

  const masterLevel = useCallback(() => {
    const v = volumeRef.current;
    return typeof v === "number" && Number.isFinite(v) ? Math.min(1.5, Math.max(0, v)) : 1;
  }, []);

  const setActive = useCallback((active: boolean) => {
    setEqActive(active);
    onActiveRef.current?.(active);
  }, []);

  const disableEq = useCallback(() => {
    const el = mediaRef.current;
    if (el) disableElementEq(el);
    setActive(false);
  }, [mediaRef, setActive]);

  const eqOpts = useCallback(
    (presetId: EqPresetId, gains: number[]) => ({
      gainsDb: gainsForPreset(presetId, gains),
      masterGain: masterLevel(),
    }),
    [masterLevel]
  );

  const applyGainsNow = useCallback(
    async (presetId: EqPresetId, gains: number[]) => {
      const el = mediaRef.current;
      if (!el) return;
      await applyElementEqPreset(el, eqOpts(presetId, gains), eqScope);
    },
    [eqOpts, eqScope, mediaRef]
  );

  const ensureEq = useCallback(async (): Promise<boolean> => {
    const el = mediaRef.current;
    if (!el || !eqEnabled || busyRef.current) return false;
    const gen = ++ensureEqGenRef.current;
    busyRef.current = true;
    setEqErr(null);
    try {
      await resumeEqContextFromGesture();
      if (gen !== ensureEqGenRef.current) return false;
      await applyElementEqPreset(el, eqOpts(presetRef.current, customRef.current), eqScope);
      if (gen !== ensureEqGenRef.current) return false;
      setActive(true);
      return true;
    } catch (e) {
      if (gen !== ensureEqGenRef.current) return false;
      disableEq();
      setEqErr(e instanceof Error ? e.message : "Could not start equalizer.");
      return false;
    } finally {
      if (gen === ensureEqGenRef.current) busyRef.current = false;
    }
  }, [disableEq, eqEnabled, eqOpts, eqScope, mediaRef, setActive]);

  const applyPresetLive = useCallback(
    (presetId: EqPresetId, gains?: number[]) => {
      if (!eqEnabled) return;
      const el = mediaRef.current;
      if (!el) return;
      const g = gains ?? customRef.current;
      const opts = eqOpts(presetId, g);
      if (updateElementEqLive(el, opts)) {
        void resumeEqContextForPlayback();
        setActive(true);
        return;
      }
      void applyGainsNow(presetId, g).then(() => {
        if (isEqFilterGraphActive(el)) setActive(true);
      });
    },
    [applyGainsNow, eqEnabled, eqOpts, mediaRef, setActive]
  );

  const handlePopoverToggle = useCallback(() => {
    const opening = !open;
    if (opening) {
      void resumeEqContextFromGesture().then(() => ensureEq());
    }
    setOpen(opening);
  }, [ensureEq, open]);

  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value as EqPresetId;
      presetRef.current = id;
      setPreset(id);
      applyPresetLive(id);
    },
    [applyPresetLive]
  );

  useEffect(() => {
    const next = loadEqSettingsForScope(eqScope);
    setPreset(next.preset);
    setCustomGains(next.customGains);
    presetRef.current = next.preset;
    customRef.current = next.customGains;
  }, [eqScope]);

  useEffect(() => {
    saveEqSettingsForScope(eqScope, { preset, customGains });
  }, [eqScope, preset, customGains]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !eqActive) return;
    setEqMasterGain(el, masterLevel());
  }, [volume, eqActive, masterLevel, mediaRef]);

  const scopeStreamKey = `${eqScope}:${streamKey ?? ""}`;

  useEffect(() => {
    const el = mediaRef.current;
    if (el && eqEnabled) {
      handoffEqScope(el, eqScope, volumeRef.current);
    }
    disableEq();
    setOpen(false);
    setEqErr(null);
  }, [scopeStreamKey, eqScope, eqEnabled, disableEq]);

  useEffect(() => {
    if (!eqEnabled) {
      disableEq();
      setOpen(false);
      setEqErr(null);
    }
  }, [eqEnabled, disableEq]);

  useEffect(() => {
    return () => {
      disableElementEq(mediaRef.current);
    };
  }, [mediaRef]);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent) => {
      const host = popoverRef.current;
      const t = ev.target;
      if (!(t instanceof Node) || !host) return;
      if (host.contains(t)) return;
      if (anchoredPanelRef.current?.contains(t)) return;
      const active = document.activeElement;
      if (active instanceof HTMLSelectElement && host.contains(active)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onBandChange = (index: number, value: number) => {
    setPreset("custom");
    presetRef.current = "custom";
    setCustomGains((prev) => {
      const next = [...prev];
      next[index] = value;
      customRef.current = next;
      applyPresetLive("custom", next);
      return next;
    });
  };

  if (!eqEnabled) return null;

  return (
    <div className="volume-popover-host radio-eq-popover-host" ref={popoverRef}>
      <button
        ref={triggerRef}
        type="button"
        className="volume-popover-trigger radio-eq-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        id={triggerId}
        title="Equalizer presets"
        onClick={handlePopoverToggle}
      >
        <span className="volume-popover-glyph" aria-hidden>
          EQ
        </span>
        <span className="volume-popover-pct">{EQ_PRESET_SHORT[preset]}</span>
      </button>
      {open && anchoredPopover ? (
        <AnchoredPopover
          open={open}
          anchorRef={triggerRef}
          panelRef={anchoredPanelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={triggerId}
          align="end"
          preferAbove
          className="volume-popover-panel radio-eq-popover-panel volume-popover-panel--anchored"
        >
          <div className="volume-popover-panel-inner">
            <span className="volume-popover-title">Equalizer</span>
            <label className="radio-eq-popover-label" htmlFor={presetId}>
              Preset
            </label>
            <select
              id={presetId}
              className="radio-eq-select radio-eq-select--popover"
              value={preset}
              onChange={handlePresetChange}
            >
              {[...EQ_PRESET_ORDER, "custom" as const].map((id) => (
                <option key={id} value={id}>
                  {EQ_PRESET_DISPLAY[id]}
                </option>
              ))}
            </select>
            {eqErr ? <p className="radio-eq-err">{eqErr}</p> : null}
            {preset === "custom" ? (
              <div className="radio-eq-sliders radio-eq-sliders--popover" aria-label="Custom equalizer bands">
                {EQ_BAND_LABELS.map((label, i) => (
                  <div key={label} className="radio-eq-band radio-eq-band--popover">
                    <label>{label}</label>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={0.5}
                      value={customGains[i] ?? 0}
                      onChange={(e) => onBandChange(i, Number(e.target.value))}
                      aria-label={`${label} Hz`}
                    />
                    <span className="radio-eq-band-val">
                      {(customGains[i] ?? 0) > 0 ? "+" : ""}
                      {(customGains[i] ?? 0).toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </AnchoredPopover>
      ) : null}
      {open && !anchoredPopover ? (
        <div className="volume-popover-panel radio-eq-popover-panel" id={panelId} role="dialog" aria-labelledby={triggerId}>
          <div className="volume-popover-panel-inner">
            <span className="volume-popover-title">Equalizer</span>
            <label className="radio-eq-popover-label" htmlFor={presetId}>
              Preset
            </label>
            <select
              id={presetId}
              className="radio-eq-select radio-eq-select--popover"
              value={preset}
              onChange={handlePresetChange}
            >
              {[...EQ_PRESET_ORDER, "custom" as const].map((id) => (
                <option key={id} value={id}>
                  {EQ_PRESET_DISPLAY[id]}
                </option>
              ))}
            </select>
            {eqErr ? <p className="radio-eq-err">{eqErr}</p> : null}
            {preset === "custom" ? (
              <div className="radio-eq-sliders radio-eq-sliders--popover" aria-label="Custom equalizer bands">
                {EQ_BAND_LABELS.map((label, i) => (
                  <div key={label} className="radio-eq-band radio-eq-band--popover">
                    <label>{label}</label>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={0.5}
                      value={customGains[i] ?? 0}
                      onChange={(e) => onBandChange(i, Number(e.target.value))}
                      aria-label={`${label} Hz`}
                    />
                    <span className="radio-eq-band-val">
                      {(customGains[i] ?? 0) > 0 ? "+" : ""}
                      {(customGains[i] ?? 0).toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}