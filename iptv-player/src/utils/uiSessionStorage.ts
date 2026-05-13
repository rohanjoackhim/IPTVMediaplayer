import { parseEqCustomGains, parseEqPresetId, type EqPresetId } from "./eqPresets";

const KEY = "iptv-ui-session";

export type ListTabPersisted = "all" | "favorites";
export type AssignPanePersisted = "L" | "R";
export type SidebarModePersisted = "tv" | "radio" | "audio";

export interface UiSession {
  v: 7;
  listTab: ListTabPersisted;
  /** Radio sidebar: all stations in country vs favorites only (same URLs as Television favorites). */
  radioListTab: ListTabPersisted;
  /** Left sidebar: IPTV, online radio, or local MP3 / audiobooks. */
  sidebarMode: SidebarModePersisted;
  /** Radio Browser country name (exact match to API country list). */
  radioCountry: string;
  query: string;
  group: string;
  country: string;
  splitView: boolean;
  assignTarget: AssignPanePersisted;
  volumeLeft: number;
  volumeRight: number;
  /** Desktop: channel list sidebar width in CSS pixels. */
  sidebarWidthPx: number;
  /** Radio Web Audio EQ preset; shared across all stations until changed. */
  radioEqPreset: EqPresetId;
  /** Per-band dB when `radioEqPreset` is `custom`. */
  radioEqCustomGains: number[];
}

const defaultSession: UiSession = {
  v: 7,
  listTab: "all",
  radioListTab: "all",
  sidebarMode: "tv",
  radioCountry: "",
  query: "",
  group: "All groups",
  country: "All countries",
  splitView: false,
  assignTarget: "L",
  volumeLeft: 1,
  volumeRight: 1,
  sidebarWidthPx: 400,
  radioEqPreset: "flat",
  radioEqCustomGains: parseEqCustomGains(undefined),
};

function vol(x: unknown, d: number) {
  return typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d;
}

export function clampSidebarWidthPx(n: number): number {
  if (!Number.isFinite(n)) return defaultSession.sidebarWidthPx;
  return Math.round(Math.min(720, Math.max(260, n)));
}

function parseSidebarMode(raw: unknown): SidebarModePersisted {
  if (raw === "radio") return "radio";
  if (raw === "audio") return "audio";
  return "tv";
}

function parseListTab(raw: unknown): ListTabPersisted {
  return raw === "favorites" ? "favorites" : "all";
}

function migrateFromV2(o: Record<string, unknown>): UiSession {
  return {
    v: 7,
    listTab: o.listTab === "favorites" ? "favorites" : "all",
    radioListTab: "all",
    sidebarMode: "tv",
    radioCountry: "",
    query: typeof o.query === "string" ? o.query : "",
    group: typeof o.group === "string" ? o.group : "All groups",
    country: typeof o.country === "string" ? o.country : "All countries",
    splitView: !!o.splitView,
    assignTarget: o.assignTarget === "R" ? "R" : "L",
    volumeLeft: vol(o.volumeLeft, 1),
    volumeRight: vol(o.volumeRight, 1),
    sidebarWidthPx: defaultSession.sidebarWidthPx,
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: [...defaultSession.radioEqCustomGains],
  };
}

function migrateFromV3(o: Record<string, unknown>): UiSession {
  return {
    v: 7,
    listTab: o.listTab === "favorites" ? "favorites" : "all",
    radioListTab: "all",
    sidebarMode: parseSidebarMode(o.sidebarMode),
    radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
    query: typeof o.query === "string" ? o.query : "",
    group: typeof o.group === "string" ? o.group : "All groups",
    country: typeof o.country === "string" ? o.country : "All countries",
    splitView: !!o.splitView,
    assignTarget: o.assignTarget === "R" ? "R" : "L",
    volumeLeft: vol(o.volumeLeft, 1),
    volumeRight: vol(o.volumeRight, 1),
    sidebarWidthPx: clampSidebarWidthPx(
      typeof o.sidebarWidthPx === "number" ? o.sidebarWidthPx : defaultSession.sidebarWidthPx
    ),
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: [...defaultSession.radioEqCustomGains],
  };
}

function migrateFromV4(o: Record<string, unknown>): UiSession {
  return {
    v: 7,
    listTab: o.listTab === "favorites" ? "favorites" : "all",
    radioListTab: "all",
    sidebarMode: parseSidebarMode(o.sidebarMode),
    radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
    query: typeof o.query === "string" ? o.query : "",
    group: typeof o.group === "string" ? o.group : "All groups",
    country: typeof o.country === "string" ? o.country : "All countries",
    splitView: !!o.splitView,
    assignTarget: o.assignTarget === "R" ? "R" : "L",
    volumeLeft: vol(o.volumeLeft, 1),
    volumeRight: vol(o.volumeRight, 1),
    sidebarWidthPx: clampSidebarWidthPx(
      typeof o.sidebarWidthPx === "number" ? o.sidebarWidthPx : defaultSession.sidebarWidthPx
    ),
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: [...defaultSession.radioEqCustomGains],
  };
}

function migrateFromV5(o: Record<string, unknown>): UiSession {
  return {
    v: 7,
    listTab: o.listTab === "favorites" ? "favorites" : "all",
    radioListTab: parseListTab(o.radioListTab),
    sidebarMode: parseSidebarMode(o.sidebarMode),
    radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
    query: typeof o.query === "string" ? o.query : "",
    group: typeof o.group === "string" ? o.group : "All groups",
    country: typeof o.country === "string" ? o.country : "All countries",
    splitView: !!o.splitView,
    assignTarget: o.assignTarget === "R" ? "R" : "L",
    volumeLeft: vol(o.volumeLeft, 1),
    volumeRight: vol(o.volumeRight, 1),
    sidebarWidthPx: clampSidebarWidthPx(
      typeof o.sidebarWidthPx === "number" ? o.sidebarWidthPx : defaultSession.sidebarWidthPx
    ),
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: [...defaultSession.radioEqCustomGains],
  };
}

function migrateFromV6(o: Record<string, unknown>): UiSession {
  return {
    v: 7,
    listTab: o.listTab === "favorites" ? "favorites" : "all",
    radioListTab: parseListTab(o.radioListTab),
    sidebarMode: parseSidebarMode(o.sidebarMode),
    radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
    query: typeof o.query === "string" ? o.query : "",
    group: typeof o.group === "string" ? o.group : "All groups",
    country: typeof o.country === "string" ? o.country : "All countries",
    splitView: !!o.splitView,
    assignTarget: o.assignTarget === "R" ? "R" : "L",
    volumeLeft: vol(o.volumeLeft, 1),
    volumeRight: vol(o.volumeRight, 1),
    sidebarWidthPx: clampSidebarWidthPx(
      typeof o.sidebarWidthPx === "number" ? o.sidebarWidthPx : defaultSession.sidebarWidthPx
    ),
    radioEqPreset: parseEqPresetId(o.radioEqPreset),
    radioEqCustomGains: parseEqCustomGains(o.radioEqCustomGains),
  };
}

function migrateFromV1(o: Record<string, unknown>): UiSession {
  return migrateFromV2({
    ...o,
    splitView: false,
    assignTarget: "L",
    volumeLeft: 1,
    volumeRight: 1,
  });
}

export function loadUiSession(): UiSession {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSession };
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.v === 1) return migrateFromV1(o);
    if (o.v === 2) return migrateFromV2(o);
    if (o.v === 3) return migrateFromV3(o);
    if (o.v === 4) return migrateFromV4(o);
    if (o.v === 5) return migrateFromV5(o);
    if (o.v === 6) return migrateFromV6(o);
    if (o.v !== 7) return { ...defaultSession };
    return {
      v: 7,
      listTab: o.listTab === "favorites" ? "favorites" : "all",
      radioListTab: parseListTab(o.radioListTab),
      sidebarMode: parseSidebarMode(o.sidebarMode),
      radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
      query: typeof o.query === "string" ? o.query : "",
      group: typeof o.group === "string" ? o.group : "All groups",
      country: typeof o.country === "string" ? o.country : "All countries",
      splitView: !!o.splitView,
      assignTarget: o.assignTarget === "R" ? "R" : "L",
      volumeLeft: vol(o.volumeLeft, 1),
      volumeRight: vol(o.volumeRight, 1),
      sidebarWidthPx: clampSidebarWidthPx(
        typeof o.sidebarWidthPx === "number" ? o.sidebarWidthPx : defaultSession.sidebarWidthPx
      ),
      radioEqPreset: parseEqPresetId(o.radioEqPreset),
      radioEqCustomGains: parseEqCustomGains(o.radioEqCustomGains),
    };
  } catch {
    return { ...defaultSession };
  }
}

export function saveUiSession(partial: Partial<Omit<UiSession, "v">>): void {
  try {
    const cur = loadUiSession();
    const next: UiSession = {
      v: 7,
      listTab: partial.listTab ?? cur.listTab,
      radioListTab: partial.radioListTab ?? cur.radioListTab,
      sidebarMode: partial.sidebarMode ?? cur.sidebarMode,
      radioCountry: partial.radioCountry !== undefined ? partial.radioCountry : cur.radioCountry,
      query: partial.query !== undefined ? partial.query : cur.query,
      group: partial.group !== undefined ? partial.group : cur.group,
      country: partial.country !== undefined ? partial.country : cur.country,
      splitView: partial.splitView !== undefined ? partial.splitView : cur.splitView,
      assignTarget: partial.assignTarget !== undefined ? partial.assignTarget : cur.assignTarget,
      volumeLeft: partial.volumeLeft !== undefined ? partial.volumeLeft : cur.volumeLeft,
      volumeRight: partial.volumeRight !== undefined ? partial.volumeRight : cur.volumeRight,
      sidebarWidthPx:
        partial.sidebarWidthPx !== undefined
          ? clampSidebarWidthPx(partial.sidebarWidthPx)
          : cur.sidebarWidthPx,
      radioEqPreset: partial.radioEqPreset ?? cur.radioEqPreset,
      radioEqCustomGains:
        partial.radioEqCustomGains !== undefined
          ? parseEqCustomGains(partial.radioEqCustomGains)
          : [...cur.radioEqCustomGains],
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}
