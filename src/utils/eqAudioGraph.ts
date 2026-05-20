import { EQ_BAND_HZ } from "./eqPresets";
import type { EqPageScope } from "./eqScopeSettings";

export type EqSession = {
  ctx: AudioContext;
  source: AudioNode;
  usesCapture: boolean;
  filters: BiquadFilterNode[];
  master: GainNode;
  element: HTMLMediaElement;
  prevMuted: boolean;
};

const sessions = new WeakMap<HTMLMediaElement, EqSession>();

/**
 * Legacy: `createMediaElementSource` cannot be undone. If Sound EQ created one earlier
 * in this app session, we keep flat passthrough for normal playback until app restart.
 */
const legacyElementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
const legacyPassthroughMasters = new WeakMap<HTMLMediaElement, GainNode>();

type MediaElEqCache = HTMLMediaElement & { __iptvCaptureStream?: MediaStream };

let sharedCtx: AudioContext | null = null;
let activeEqScope: EqPageScope | null = null;

export function getActiveEqScope(): EqPageScope | null {
  return activeEqScope;
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

function getSharedEqContext(): AudioContext | null {
  const AC = getAudioContextCtor();
  if (!AC) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new AC();
  }
  return sharedCtx;
}

/** Must run during a user gesture (EQ button click). */
export async function resumeEqContextFromGesture(): Promise<AudioContext | null> {
  const ctx = getSharedEqContext();
  if (!ctx) return null;
  if (ctx.state === "running") return ctx;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return ctx;
    }
  }
  return ctx;
}

/** Resume AudioContext when playback starts (no EQ button click required). */
export async function resumeEqContextForPlayback(): Promise<AudioContext | null> {
  const ctx = getSharedEqContext();
  if (!ctx) return null;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* autoplay policy — playing handler may retry */
    }
  }
  return ctx;
}

export function kickEqContext(): void {
  const ctx = getSharedEqContext();
  if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
  void ctx.resume().catch(() => {});
}

export function isEqEnabled(el: HTMLMediaElement): boolean {
  const s = sessions.get(el);
  return !!s && s.ctx.state !== "closed";
}

export function isEqFilterGraphActive(el: HTMLMediaElement): boolean {
  return isEqEnabled(el);
}

/** True when audio is routed through Web Audio instead of the element speaker path. */
export function isElementAudioRouted(el: HTMLMediaElement): boolean {
  return isEqEnabled(el) || legacyElementSources.has(el);
}

/** Live preset tweak while EQ is already running — no graph rebuild. */
export function updateElementEqLive(
  el: HTMLMediaElement,
  opts: { gainsDb: number[]; masterGain: number }
): boolean {
  if (!isEqFilterGraphActive(el)) return false;
  applyEqBandGains(el, opts.gainsDb);
  setEqMasterGain(el, opts.masterGain);
  kickEqContext();
  return true;
}

export function applyEqBandGains(el: HTMLMediaElement, gainsDb: number[]): void {
  const s = sessions.get(el);
  if (!s) return;
  const t = s.ctx.currentTime;
  for (let i = 0; i < s.filters.length; i++) {
    const db = gainsDb[i];
    if (typeof db === "number" && Number.isFinite(db)) {
      s.filters[i].gain.setValueAtTime(db, t);
    }
  }
  kickEqContext();
}

export function setEqMasterGain(el: HTMLMediaElement, level: number): void {
  const v = clampMasterGain(level);
  const s = sessions.get(el);
  if (s && s.ctx.state !== "closed") {
    s.master.gain.setValueAtTime(v, s.ctx.currentTime);
    kickEqContext();
    return;
  }
  const passthrough = legacyPassthroughMasters.get(el);
  if (passthrough && passthrough.context.state !== "closed") {
    passthrough.gain.setValueAtTime(v, passthrough.context.currentTime);
  }
}

function clampMasterGain(level: number): number {
  return Math.min(1, Math.max(0, level));
}

/** Routes that should use createMediaElementSource (no mute / captureStream). */
function prefersMediaElementSource(scope: EqPageScope | null | undefined): boolean {
  return scope === "library" || scope === "radio";
}

function waitForMediaReady(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener("canplay", done);
      el.removeEventListener("loadeddata", done);
      resolve();
    };
    el.addEventListener("canplay", done, { once: true });
    el.addEventListener("loadeddata", done, { once: true });
  });
}

function captureStreamFromElement(el: HTMLMediaElement): MediaStream {
  const cap = (el as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof cap !== "function") {
    throw new Error("Equalizer is not supported in this player.");
  }
  return cap.call(el);
}

function captureStreamIsLive(stream: MediaStream): boolean {
  const tracks = stream.getAudioTracks();
  return tracks.length > 0 && tracks.some((t) => t.readyState === "live");
}

function invalidateCaptureStream(el: HTMLMediaElement): void {
  const ext = el as MediaElEqCache;
  const cached = ext.__iptvCaptureStream;
  if (cached) {
    for (const t of cached.getAudioTracks()) {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    }
  }
  delete ext.__iptvCaptureStream;
}

async function waitForPlaying(el: HTMLMediaElement): Promise<void> {
  if (!el.paused && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("playing", done);
      el.removeEventListener("canplay", done);
      resolve();
    };
    el.addEventListener("playing", done, { once: true });
    el.addEventListener("canplay", done, { once: true });
    window.setTimeout(done, 2500);
  });
}

function getOrCreateCaptureStream(el: HTMLMediaElement): MediaStream {
  const ext = el as MediaElEqCache;
  const cached = ext.__iptvCaptureStream;
  if (cached && captureStreamIsLive(cached)) return cached;

  invalidateCaptureStream(el);
  const stream = captureStreamFromElement(el);
  if (stream.getAudioTracks().length === 0) {
    throw new Error("Could not capture audio from this track.");
  }
  ext.__iptvCaptureStream = stream;
  return stream;
}

function tryRegisterLegacyMes(el: HTMLMediaElement, ctx: AudioContext): MediaElementAudioSourceNode | null {
  const existing = legacyElementSources.get(el);
  if (existing) return existing;
  try {
    const mes = ctx.createMediaElementSource(el);
    legacyElementSources.set(el, mes);
    return mes;
  } catch {
    return null;
  }
}

function disconnectNode(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    /* noop */
  }
}

function disconnectSessionNodes(session: EqSession): void {
  disconnectNode(session.source);
  for (const f of session.filters) disconnectNode(f);
  disconnectNode(session.master);
}

function clearLegacyPassthrough(el: HTMLMediaElement): void {
  const master = legacyPassthroughMasters.get(el);
  if (master) {
    disconnectNode(master);
    legacyPassthroughMasters.delete(el);
  }
}

function routeLegacyPassthrough(el: HTMLMediaElement, ctx: AudioContext, masterGain: number): void {
  const mes = legacyElementSources.get(el);
  if (!mes) return;
  disconnectNode(mes);
  clearLegacyPassthrough(el);
  const master = ctx.createGain();
  master.gain.value = clampMasterGain(masterGain);
  mes.connect(master);
  master.connect(ctx.destination);
  legacyPassthroughMasters.set(el, master);
  el.muted = false;
  void ctx.resume().catch(() => {});
  kickEqContext();
}

function wireEqGraph(
  ctx: AudioContext,
  source: AudioNode,
  gainsDb: number[],
  masterGain: number
): { filters: BiquadFilterNode[]; master: GainNode } {
  const filters = EQ_BAND_HZ.map((hz) => {
    const f = ctx.createBiquadFilter();
    f.type = "peaking";
    f.frequency.value = hz;
    f.Q.value = 1.15;
    f.gain.value = 0;
    return f;
  });
  const master = ctx.createGain();
  master.gain.value = clampMasterGain(masterGain);

  let node: AudioNode = source;
  for (const band of filters) {
    node.connect(band);
    node = band;
  }
  node.connect(master);
  master.connect(ctx.destination);

  for (let i = 0; i < filters.length; i++) {
    const db = gainsDb[i];
    if (typeof db === "number" && Number.isFinite(db)) filters[i].gain.value = db;
  }
  master.gain.value = clampMasterGain(masterGain);

  return { filters, master };
}

/** EQ via captureStream — element is muted; audio comes from the captured MediaStream. */
async function enableCaptureEq(
  el: HTMLMediaElement,
  ctx: AudioContext,
  opts: { gainsDb: number[]; masterGain: number }
): Promise<void> {
  await waitForMediaReady(el);
  await waitForPlaying(el);
  clearLegacyPassthrough(el);
  const prevMuted = el.muted;

  let stream = getOrCreateCaptureStream(el);
  if (!captureStreamIsLive(stream)) {
    invalidateCaptureStream(el);
    await new Promise((r) => window.setTimeout(r, 80));
    stream = getOrCreateCaptureStream(el);
  }

  const source = ctx.createMediaStreamSource(stream);
  const { filters, master } = wireEqGraph(ctx, source, opts.gainsDb, opts.masterGain);
  el.muted = true;
  sessions.set(el, {
    ctx,
    source,
    usesCapture: true,
    filters,
    master,
    element: el,
    prevMuted,
  });
  await resumeEqContextForPlayback();
  kickEqContext();
}

/**
 * Legacy upgrade: MES → filters (only when an old Sound-tab session already created MES).
 * Disconnect the source before tearing down passthrough so the graph stays valid.
 */
function enableLegacyMesEq(
  el: HTMLMediaElement,
  ctx: AudioContext,
  opts: { gainsDb: number[]; masterGain: number }
): void {
  const mes = legacyElementSources.get(el);
  if (!mes) return;
  disconnectNode(mes);
  clearLegacyPassthrough(el);
  const { filters, master } = wireEqGraph(ctx, mes, opts.gainsDb, opts.masterGain);
  sessions.set(el, {
    ctx,
    source: mes,
    usesCapture: false,
    filters,
    master,
    element: el,
    prevMuted: el.muted,
  });
  el.muted = false;
  void ctx.resume().catch(() => {});
  kickEqContext();
}

export async function applyElementEqPreset(
  el: HTMLMediaElement,
  opts: { gainsDb: number[]; masterGain: number },
  scope?: EqPageScope | null
): Promise<void> {
  if (scope) activeEqScope = scope;
  const ctx = await resumeEqContextFromGesture();
  if (!ctx) throw new Error("Web Audio is not available or could not start.");

  if (isEqFilterGraphActive(el)) {
    const active = sessions.get(el);
    if (active?.usesCapture && prefersMediaElementSource(scope) && !legacyElementSources.has(el)) {
      const level = active.master.gain.value;
      disconnectSessionNodes(active);
      sessions.delete(el);
      invalidateCaptureStream(el);
      el.muted = false;
      el.volume = clampMasterGain(level);
    } else {
      applyEqBandGains(el, opts.gainsDb);
      setEqMasterGain(el, opts.masterGain);
      await resumeEqContextForPlayback();
      kickEqContext();
      return;
    }
  }

  const existing = sessions.get(el);
  if (existing) {
    disconnectSessionNodes(existing);
    sessions.delete(el);
    if (existing.usesCapture) {
      invalidateCaptureStream(el);
      existing.element.muted = false;
    }
  }

  /** Library + radio: element source — uninterrupted playback and live preset tweaks. */
  if (prefersMediaElementSource(scope)) {
    const mes = tryRegisterLegacyMes(el, ctx);
    if (mes) {
      enableLegacyMesEq(el, ctx, opts);
      await resumeEqContextForPlayback();
      return;
    }
  }

  if (legacyElementSources.has(el)) {
    enableLegacyMesEq(el, ctx, opts);
    await resumeEqContextForPlayback();
    return;
  }

  try {
    await enableCaptureEq(el, ctx, opts);
  } catch (captureErr) {
    disableElementEq(el);
    const mes = tryRegisterLegacyMes(el, ctx);
    if (mes) {
      enableLegacyMesEq(el, ctx, opts);
      await resumeEqContextForPlayback();
      return;
    }
    throw captureErr;
  }
}

export async function enableElementEq(
  el: HTMLMediaElement,
  opts: { gainsDb: number[]; masterGain: number }
): Promise<void> {
  await applyElementEqPreset(el, opts);
}

/** Turn off EQ and restore normal element playback. */
export function disableElementEq(el: HTMLMediaElement | null | undefined): void {
  if (!el) return;
  const session = sessions.get(el);
  if (!session) return;

  const masterLevel = session.master.gain.value;
  const element = session.element;
  disconnectSessionNodes(session);
  sessions.delete(el);
  invalidateCaptureStream(el);

  if (legacyElementSources.has(el)) {
    routeLegacyPassthrough(el, session.ctx, masterLevel);
    return;
  }

  element.muted = false;
  element.volume = clampMasterGain(masterLevel);
  void session.ctx.resume().catch(() => {});
}

export function handoffEqScope(
  el: HTMLMediaElement | null | undefined,
  scope: EqPageScope | null,
  volume: number
): void {
  if (!el) return;
  activeEqScope = scope;
  const level = clampMasterGain(volume);

  disableElementEq(el);

  if (legacyElementSources.has(el)) {
    void resumeEqContextForPlayback().then((ctx) => {
      if (!ctx) return;
      routeLegacyPassthrough(el, ctx, level);
    });
    return;
  }

  el.muted = false;
  el.volume = level;
}

export async function ensureElementPlaybackAudible(
  el: HTMLMediaElement,
  volume: number
): Promise<void> {
  const level = clampMasterGain(volume);
  if (isEqFilterGraphActive(el)) {
    const session = sessions.get(el);
    if (session?.usesCapture) el.muted = true;
    else el.muted = false;
    setEqMasterGain(el, level);
    await resumeEqContextForPlayback();
    return;
  }
  if (legacyElementSources.has(el)) {
    const ctx = await resumeEqContextForPlayback();
    if (!ctx) return;
    routeLegacyPassthrough(el, ctx, level);
    return;
  }
  el.muted = false;
  el.volume = level;
}

export function releaseEqForMediaElement(
  el: HTMLMediaElement | null | undefined,
  volume = 1
): void {
  if (!el) return;
  handoffEqScope(el, null, volume);
  invalidateCaptureStream(el);
}

/** @deprecated No new MES instances are created; kept so old sessions can still call this. */
export function migrateLegacyElementSource(el: HTMLMediaElement, mes: MediaElementAudioSourceNode): void {
  legacyElementSources.set(el, mes);
}
