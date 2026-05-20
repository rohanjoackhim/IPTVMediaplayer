import { parseEqCustomGains, parseEqPresetId, type EqPresetId } from "./eqPresets";

const KEY = "iptv-ui-session";

export type ListTabPersisted = "all" | "favorites" | "localVideos";
/** Radio sidebar: only all vs favorites (no local-files tab). */
export type RadioListTabPersisted = "all" | "favorites";
/** Podcast sidebar: all shows/episodes vs favorites only. */
export type PodcastListTabPersisted = "all" | "favorites";
export type AssignPanePersisted = "L" | "R";
export type SidebarModePersisted = "tv" | "radio" | "audio";

export interface UiSession {
  v: 10;
  listTab: ListTabPersisted;
  /** Radio sidebar: all stations in country vs favorites only (same URLs as Television favorites). */
  radioListTab: RadioListTabPersisted;
  /** Podcast sidebar: all vs favorites only. */
  podcastListTab: PodcastListTabPersisted;
  /** Left sidebar: IPTV, online radio/podcasts, or Audio. */
  sidebarMode: SidebarModePersisted;
  /** Radio Browser country name (exact match to API country list). */
  radioCountry: string;
  /** iTunes storefront country code for podcast discovery (e.g. us, gb). */
  podcastCountry: string;
  /** Apple Podcasts genre id; 0 = all genres. */
  podcastGenreId: number;
  query: string;
  group: string;
  country: string;
  splitView: boolean;
  assignTarget: AssignPanePersisted;
  volumeLeft: number;
  volumeRight: number;
  /** Desktop: channel list sidebar width in CSS pixels. */
  sidebarWidthPx: number;
  /** Radio Web Audio EQ preset. */
  radioEqPreset: EqPresetId;
  /** Per-band dB when `radioEqPreset` is `custom`. */
  radioEqCustomGains: number[];
  /** Local library (Sound tab) EQ preset — independent from radio/podcast. */
  libraryEqPreset: EqPresetId;
  libraryEqCustomGains: number[];
  /** Podcast tab EQ preset — independent from library/radio. */
  podcastEqPreset: EqPresetId;
  podcastEqCustomGains: number[];
  /** Local library audio: pick next track at random when a track ends (with continuous play). */
  audioLibraryShuffle: boolean;
  /** Local library audio: when a track ends, start the next (or random if shuffle) in the library list. */
  audioLibraryContinuous: boolean;
  /** Hide the library sidebar and maximize the player / reader area. */
  compactView: boolean;
}

const defaultSession: UiSession = {
  v: 10,
  listTab: "all",
  radioListTab: "all",
  podcastListTab: "all",
  sidebarMode: "tv",
  radioCountry: "",
  podcastCountry: "us",
  podcastGenreId: 0,
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
  libraryEqPreset: "flat",
  libraryEqCustomGains: parseEqCustomGains(undefined),
  podcastEqPreset: "flat",
  podcastEqCustomGains: parseEqCustomGains(undefined),
  audioLibraryShuffle: false,
  audioLibraryContinuous: false,
  compactView: false,
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
  if (raw === "podcast") return "radio";
  if (raw === "audio") return "audio";
  return "tv";
}

function parsePodcastListTab(raw: unknown): PodcastListTabPersisted {
  return raw === "favorites" ? "favorites" : "all";
}

function parsePodcastGenreId(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function parseRadioListTab(raw: unknown): RadioListTabPersisted {
  return raw === "favorites" ? "favorites" : "all";
}

function parseListTab(raw: unknown): ListTabPersisted {
  if (raw === "favorites") return "favorites";
  if (raw === "localVideos") return "localVideos";
  return "all";
}

function migrateFromV9(o: Record<string, unknown>): UiSession {
  const radioPreset = parseEqPresetId(o.radioEqPreset);
  const radioCustom = parseEqCustomGains(o.radioEqCustomGains);
  return {
    v: 10,
    listTab: parseListTab(o.listTab),
    radioListTab: parseRadioListTab(o.radioListTab),
    podcastListTab: parsePodcastListTab(o.podcastListTab),
    sidebarMode: parseSidebarMode(o.sidebarMode),
    radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
    podcastCountry: typeof o.podcastCountry === "string" && o.podcastCountry.trim() ? o.podcastCountry : "us",
    podcastGenreId: parsePodcastGenreId(o.podcastGenreId),
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
    radioEqPreset: radioPreset,
    radioEqCustomGains: radioCustom,
    libraryEqPreset: parseEqPresetId(o.libraryEqPreset) || radioPreset,
    libraryEqCustomGains: parseEqCustomGains(o.libraryEqCustomGains).length
      ? parseEqCustomGains(o.libraryEqCustomGains)
      : [...radioCustom],
    podcastEqPreset: parseEqPresetId(o.podcastEqPreset) || radioPreset,
    podcastEqCustomGains: parseEqCustomGains(o.podcastEqCustomGains).length
      ? parseEqCustomGains(o.podcastEqCustomGains)
      : [...radioCustom],
    audioLibraryShuffle: typeof o.audioLibraryShuffle === "boolean" ? o.audioLibraryShuffle : false,
    audioLibraryContinuous: typeof o.audioLibraryContinuous === "boolean" ? o.audioLibraryContinuous : false,
    compactView: typeof o.compactView === "boolean" ? o.compactView : false,
  };
}

function migrateFromV8(o: Record<string, unknown>): UiSession {
  return migrateFromV9({
    ...o,
    v: 9,
    listTab: parseListTab(o.listTab),
    radioListTab: parseRadioListTab(o.radioListTab),
    podcastListTab: "all",
    sidebarMode: parseSidebarMode(o.sidebarMode),
    radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
    podcastCountry: "us",
    podcastGenreId: 0,
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
    libraryEqPreset: parseEqPresetId(o.libraryEqPreset),
    libraryEqCustomGains: parseEqCustomGains(o.libraryEqCustomGains),
    podcastEqPreset: parseEqPresetId(o.podcastEqPreset),
    podcastEqCustomGains: parseEqCustomGains(o.podcastEqCustomGains),
    audioLibraryShuffle: typeof o.audioLibraryShuffle === "boolean" ? o.audioLibraryShuffle : false,
    audioLibraryContinuous: typeof o.audioLibraryContinuous === "boolean" ? o.audioLibraryContinuous : false,
    compactView: typeof o.compactView === "boolean" ? o.compactView : false,
  });
}

function migrateFromV2(o: Record<string, unknown>): UiSession {
  return migrateFromV8({
    ...o,
    v: 8,
    radioListTab: "all",
    sidebarMode: "tv",
    radioCountry: "",
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: defaultSession.radioEqCustomGains,
    audioLibraryShuffle: false,
    audioLibraryContinuous: false,
    compactView: false,
  });
}

function migrateFromV3(o: Record<string, unknown>): UiSession {
  return migrateFromV8({
    ...o,
    v: 8,
    radioListTab: "all",
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: defaultSession.radioEqCustomGains,
    audioLibraryShuffle: false,
    audioLibraryContinuous: false,
    compactView: false,
  });
}

function migrateFromV4(o: Record<string, unknown>): UiSession {
  return migrateFromV8({
    ...o,
    v: 8,
    radioListTab: "all",
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: defaultSession.radioEqCustomGains,
    audioLibraryShuffle: false,
    audioLibraryContinuous: false,
    compactView: false,
  });
}

function migrateFromV5(o: Record<string, unknown>): UiSession {
  return migrateFromV8({
    ...o,
    v: 8,
    radioEqPreset: defaultSession.radioEqPreset,
    radioEqCustomGains: defaultSession.radioEqCustomGains,
    audioLibraryShuffle: false,
    audioLibraryContinuous: false,
    compactView: false,
  });
}

function migrateFromV6(o: Record<string, unknown>): UiSession {
  return migrateFromV8({
    ...o,
    v: 8,
    audioLibraryShuffle: false,
    audioLibraryContinuous: false,
    compactView: false,
  });
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
    if (o.v === 7 || o.v === 8) return migrateFromV8(o);
    if (o.v === 9) return migrateFromV9(o);
    if (o.v !== 10) return { ...defaultSession };
    return {
      v: 10,
      listTab: parseListTab(o.listTab),
      radioListTab: parseRadioListTab(o.radioListTab),
      podcastListTab: parsePodcastListTab(o.podcastListTab),
      sidebarMode: parseSidebarMode(o.sidebarMode),
      radioCountry: typeof o.radioCountry === "string" ? o.radioCountry : "",
      podcastCountry: typeof o.podcastCountry === "string" && o.podcastCountry.trim() ? o.podcastCountry : "us",
      podcastGenreId: parsePodcastGenreId(o.podcastGenreId),
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
      libraryEqPreset: parseEqPresetId(o.libraryEqPreset),
      libraryEqCustomGains: parseEqCustomGains(o.libraryEqCustomGains),
      podcastEqPreset: parseEqPresetId(o.podcastEqPreset),
      podcastEqCustomGains: parseEqCustomGains(o.podcastEqCustomGains),
      audioLibraryShuffle: typeof o.audioLibraryShuffle === "boolean" ? o.audioLibraryShuffle : false,
      audioLibraryContinuous: typeof o.audioLibraryContinuous === "boolean" ? o.audioLibraryContinuous : false,
      compactView: typeof o.compactView === "boolean" ? o.compactView : false,
    };
  } catch {
    return { ...defaultSession };
  }
}

export function saveUiSession(partial: Partial<Omit<UiSession, "v">>): void {
  try {
    const cur = loadUiSession();
    const next: UiSession = {
      v: 10,
      listTab: partial.listTab ?? cur.listTab,
      radioListTab: partial.radioListTab ?? cur.radioListTab,
      podcastListTab: partial.podcastListTab ?? cur.podcastListTab,
      sidebarMode: partial.sidebarMode ?? cur.sidebarMode,
      radioCountry: partial.radioCountry !== undefined ? partial.radioCountry : cur.radioCountry,
      podcastCountry: partial.podcastCountry !== undefined ? partial.podcastCountry : cur.podcastCountry,
      podcastGenreId: partial.podcastGenreId !== undefined ? parsePodcastGenreId(partial.podcastGenreId) : cur.podcastGenreId,
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
      libraryEqPreset: partial.libraryEqPreset ?? cur.libraryEqPreset,
      libraryEqCustomGains:
        partial.libraryEqCustomGains !== undefined
          ? parseEqCustomGains(partial.libraryEqCustomGains)
          : [...cur.libraryEqCustomGains],
      podcastEqPreset: partial.podcastEqPreset ?? cur.podcastEqPreset,
      podcastEqCustomGains:
        partial.podcastEqCustomGains !== undefined
          ? parseEqCustomGains(partial.podcastEqCustomGains)
          : [...cur.podcastEqCustomGains],
      audioLibraryShuffle:
        partial.audioLibraryShuffle !== undefined ? partial.audioLibraryShuffle : cur.audioLibraryShuffle,
      audioLibraryContinuous:
        partial.audioLibraryContinuous !== undefined ? partial.audioLibraryContinuous : cur.audioLibraryContinuous,
      compactView: partial.compactView !== undefined ? partial.compactView : cur.compactView,
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota */
  }
}
