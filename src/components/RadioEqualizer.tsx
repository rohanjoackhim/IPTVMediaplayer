import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  EQ_BAND_HZ,
  EQ_BAND_LABELS,
  EQ_PRESET_DISPLAY,
  EQ_PRESET_ORDER,
  gainsForPreset,
  type EqPresetId,
} from "../utils/eqPresets";
import { loadUiSession, saveUiSession } from "../utils/uiSessionStorage";
import "./RadioEqualizer.css";

type EqGraph = {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  filters: BiquadFilterNode[];
  master: GainNode;
};

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

function applyDbToFilters(filters: BiquadFilterNode[], gainsDb: number[]) {
  for (let i = 0; i < filters.length; i++) {
    const g = gainsDb[i];
    if (typeof g === "number" && Number.isFinite(g)) filters[i].gain.value = g;
  }
}

export interface RadioEqualizerProps {
  mediaRef: RefObject<HTMLVideoElement | null>;
  /** When true, show EQ UI and allow Web Audio graph (radio streams or local library blob audio). */
  eqEnabled: boolean;
  volume: number;
  /**
   * When the Web Audio EQ graph is active, the parent should keep the media element at
   * `volume === 1` and apply in-app level only via this component’s GainNode so OS volume
   * and the in-app slider combine in one predictable stage.
   */
  onWebAudioRoutingActive?: (active: boolean) => void;
}

export function RadioEqualizer({ mediaRef, eqEnabled, volume, onWebAudioRoutingActive }: RadioEqualizerProps) {
  const uid = useId();
  const toggleId = `radio-eq-toggle-${uid}`;
  const panelId = `radio-eq-panel-${uid}`;
  const presetId = `radio-eq-preset-${uid}`;

  const persistedEq = useMemo(() => {
    const s = loadUiSession();
    return { preset: s.radioEqPreset, customGains: [...s.radioEqCustomGains] };
  }, []);

  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<EqPresetId>(persistedEq.preset);
  const [customGains, setCustomGains] = useState<number[]>(persistedEq.customGains);
  const [eqErr, setEqErr] = useState<string | null>(null);
  const graphRef = useRef<EqGraph | null>(null);
  const buildingRef = useRef(false);
  const presetRef = useRef(preset);
  const customRef = useRef(customGains);
  const volumeRef = useRef(volume);
  presetRef.current = preset;
  customRef.current = customGains;
  volumeRef.current = volume;

  useEffect(() => {
    if (!open) setEqErr(null);
  }, [open]);

  useEffect(() => {
    saveUiSession({ radioEqPreset: preset, radioEqCustomGains: customGains });
  }, [preset, customGains]);

  const teardown = useCallback(() => {
    const g = graphRef.current;
    if (!g) return;
    try {
      g.source.disconnect();
    } catch {
      /* noop */
    }
    for (const f of g.filters) {
      try {
        f.disconnect();
      } catch {
        /* noop */
      }
    }
    try {
      g.master.disconnect();
    } catch {
      /* noop */
    }
    void g.ctx.close().catch(() => {});
    graphRef.current = null;
    onWebAudioRoutingActive?.(false);
  }, [onWebAudioRoutingActive]);

  useEffect(() => {
    if (!eqEnabled) {
      setOpen(false);
      setEqErr(null);
      teardown();
    }
    return () => teardown();
  }, [eqEnabled, teardown]);

  const ensureGraph = useCallback(async () => {
    const el = mediaRef.current;
    if (!el || !eqEnabled || graphRef.current || buildingRef.current) return;
    buildingRef.current = true;
    setEqErr(null);
    try {
      const AC = getAudioContextCtor();
      if (!AC) {
        setEqErr("Web Audio is not available in this browser.");
        return;
      }
      const ctx = new AC();
      const source = ctx.createMediaElementSource(el);
      // Avoid stacking element.volume with the Web Audio master gain (varies by engine).
      el.volume = 1;
      const filters = EQ_BAND_HZ.map((hz) => {
        const f = ctx.createBiquadFilter();
        f.type = "peaking";
        f.frequency.value = hz;
        f.Q.value = 1;
        f.gain.value = 0;
        return f;
      });
      const master = ctx.createGain();
      const v = volumeRef.current;
      master.gain.value = typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
      let node: AudioNode = source;
      for (const b of filters) {
        node.connect(b);
        node = b;
      }
      node.connect(master);
      master.connect(ctx.destination);
      graphRef.current = { ctx, source, filters, master };
      applyDbToFilters(filters, gainsForPreset(presetRef.current, customRef.current));
      await ctx.resume();
      onWebAudioRoutingActive?.(true);
    } catch (e) {
      graphRef.current = null;
      onWebAudioRoutingActive?.(false);
      setEqErr(
        e instanceof Error
          ? e.message.includes("MediaElement")
            ? "Equalizer could not attach (try another stream or browser)."
            : e.message
          : "Could not start equalizer."
      );
    } finally {
      buildingRef.current = false;
    }
  }, [eqEnabled, mediaRef, onWebAudioRoutingActive]);

  useEffect(() => {
    if (!open || !eqEnabled) return;
    void ensureGraph();
  }, [open, eqEnabled, ensureGraph]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    applyDbToFilters(g.filters, gainsForPreset(preset, customGains));
  }, [preset, customGains]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const v = typeof volume === "number" && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    g.master.gain.setValueAtTime(v, g.ctx.currentTime);
  }, [volume]);

  const onBandChange = (index: number, value: number) => {
    setPreset("custom");
    setCustomGains((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  if (!eqEnabled) return null;

  return (
    <>
      <button
        type="button"
        className="radio-eq-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        id={toggleId}
        onClick={() => setOpen((o) => !o)}
      >
        EQ
      </button>
      {open ? (
        <div className="radio-eq-panel" id={panelId} role="region" aria-labelledby={toggleId}>
          <div className="radio-eq-preset-row">
            <label htmlFor={presetId}>Preset</label>
            <select
              id={presetId}
              className="radio-eq-select"
              value={preset}
              onChange={(e) => setPreset(e.target.value as EqPresetId)}
            >
              {[...EQ_PRESET_ORDER, "custom" as const].map((id) => (
                <option key={id} value={id}>
                  {EQ_PRESET_DISPLAY[id]}
                </option>
              ))}
            </select>
          </div>
          {eqErr ? <p className="radio-eq-err">{eqErr}</p> : null}
          {preset === "custom" ? (
            <div className="radio-eq-sliders" aria-label="Custom equalizer bands">
              {EQ_BAND_LABELS.map((label, i) => (
                <div key={label} className="radio-eq-band">
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
                    {(customGains[i] ?? 0).toFixed(1)} dB
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="radio-eq-hint">
              Choose <strong>Custom</strong> to adjust each band. Presets apply instantly.
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
