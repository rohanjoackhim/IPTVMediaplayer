import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";
import type { Channel } from "../types";
import { clearAudioResume, loadAudioResumeSeconds } from "../utils/audioResumeStorage";
import {
  channelFromLibraryTrack,
  clearAudioLibrary,
  enrichStoredTrackWithCoverArt,
  fileToStoredTrack,
  listAudioLibraryTracks,
  persistStoredTrack,
  removeAudioLibraryTrack,
  trackFromDesktopPick,
  type PickedLocalAudioPayload,
  type StoredAudioTrack,
} from "../utils/audioLibraryDb";
import { extractAudioTagsDetailed } from "../utils/extractAudioMetadata";
import { LyricsChatTranslateSettings } from "./LyricsChatTranslateSettings";
import { AudioLibraryPlaybackControls } from "./AudioLibraryPlaybackControls";
import "./LocalAudioPanel.css";

const AUDIO_ACCEPT =
  "audio/*,.mp3,.m4a,.m4b,.aac,.ogg,.oga,.opus,.wav,.flac,.webm,.mpeg,.mpga,application/octet-stream";

type LibraryRow = {
  track: StoredAudioTrack;
  url: string;
  thumbUrl: string | null;
  /** Native tooltip: all ID3 / Vorbis tags read from the file. */
  tagsTooltip: string | null;
  tagArtist: string;
  tagTitle: string;
};

function fileHintForTrack(t: StoredAudioTrack): string {
  if (t.sourceFileName?.trim()) return t.sourceFileName.trim();
  const ext = t.contentType?.includes("flac")
    ? ".flac"
    : t.contentType?.includes("mpeg") || t.contentType?.includes("mp3")
      ? ".mp3"
      : t.contentType?.includes("mp4")
        ? ".m4a"
        : ".mp3";
  return `${t.name}${ext}`;
}

async function enrichRowWithFileTags(r: LibraryRow): Promise<LibraryRow> {
  if (!(r.track.blob instanceof Blob)) return r;
  try {
    const tags = await extractAudioTagsDetailed(r.track.blob, fileHintForTrack(r.track));
    return {
      ...r,
      tagsTooltip: tags.tooltip,
      tagArtist: tags.artist,
      tagTitle: tags.title,
    };
  } catch {
    return r;
  }
}

function formatResume(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function revokeUrl(url: string) {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* noop */
  }
}

function revokeRow(r: LibraryRow) {
  revokeUrl(r.url);
  if (r.thumbUrl) revokeUrl(r.thumbUrl);
}

function makeLibraryRow(t: StoredAudioTrack): LibraryRow {
  const cover =
    t.coverArt instanceof Blob && t.coverArt.size > 0
      ? t.coverArt
      : null;
  const thumb = cover ? URL.createObjectURL(cover) : null;
  return {
    track: t,
    url: URL.createObjectURL(t.blob),
    thumbUrl: thumb,
    tagsTooltip: null,
    tagArtist: "",
    tagTitle: "",
  };
}

function sortRows(rows: LibraryRow[]): LibraryRow[] {
  return [...rows].sort((a, b) =>
    a.track.name.localeCompare(b.track.name, undefined, { sensitivity: "base" })
  );
}

function mergeIncomingTracks(prev: LibraryRow[], incoming: StoredAudioTrack[]): LibraryRow[] {
  const m = new Map(prev.map((r) => [r.track.id, r]));
  for (const t of incoming) {
    const old = m.get(t.id);
    if (old) revokeRow(old);
    if (!(t.blob instanceof Blob)) continue;
    m.set(t.id, makeLibraryRow(t));
  }
  return sortRows(Array.from(m.values()));
}

function rowsFromIdbTracks(list: StoredAudioTrack[]): LibraryRow[] {
  const out: LibraryRow[] = [];
  for (const t of list) {
    if (!(t.blob instanceof Blob)) continue;
    out.push(makeLibraryRow(t));
  }
  return sortRows(out);
}

function mergeIdbListIntoRows(prev: LibraryRow[], list: StoredAudioTrack[]): LibraryRow[] {
  const fromDb = rowsFromIdbTracks(list);
  const dbIds = new Set(fromDb.map((r) => r.track.id));
  for (const p of prev) {
    if (dbIds.has(p.track.id)) revokeRow(p);
  }
  const kept = prev.filter((p) => !dbIds.has(p.track.id));
  return sortRows([...fromDb, ...kept]);
}

function extensionFromDesktopMime(mime: string): string {
  const m = String(mime ?? "").toLowerCase();
  if (m.includes("flac")) return ".flac";
  if (m.includes("wav")) return ".wav";
  if (m.includes("aac")) return ".aac";
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("webm")) return ".webm";
  if (m.includes("mp4") || m === "audio/mp4") return ".m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  return ".mp3";
}

function normalizePickedPayload(raw: unknown): PickedLocalAudioPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const size = typeof o.size === "number" ? o.size : 0;
  const lastModified = typeof o.lastModified === "number" ? o.lastModified : 0;
  const addedAt = typeof o.addedAt === "number" ? o.addedAt : Date.now();
  const mime = typeof o.mime === "string" ? o.mime : "audio/mpeg";
  let data: ArrayBuffer | null = null;
  if (o.data instanceof ArrayBuffer) data = o.data;
  else if (o.data instanceof Uint8Array) {
    const u = o.data;
    data = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
  }
  if (!data || size === 0) return null;

  const fileNameFromMain = typeof o.fileName === "string" ? o.fileName.trim() : "";
  const idFromMain = typeof o.id === "string" ? o.id.trim() : "";
  /** Pre-fileName Electron: path-based id only — keep it so existing IndexedDB lyrics keys still work. */
  const legacyLibDeskId =
    !fileNameFromMain && idFromMain.startsWith("lib-desk-") ? idFromMain : undefined;

  const fileName =
    fileNameFromMain ||
    (name.trim() ? `${name.trim()}${extensionFromDesktopMime(mime)}` : "") ||
    "audio.mp3";

  return {
    fileName,
    legacyLibDeskId,
    name: name.trim() || fileName.replace(/\.[^/.]+$/, "") || "Untitled",
    size,
    lastModified,
    addedAt,
    mime,
    data,
  };
}

export interface LocalAudioPanelHandle {
  clearAll: () => Promise<void>;
}

export interface LocalAudioPanelProps {
  onSelectTrack: (c: Channel) => void;
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
  onLibraryStateChange?: (state: { trackCount: number; busy: boolean }) => void;
  /** IndexedDB sidebar order (`Channel` per row) — used for continuous / shuffle advance on track end. */
  onIndexedLibraryChannelsChange?: (channels: Channel[]) => void;
  audioLibraryShuffle: boolean;
  audioLibraryContinuous: boolean;
  onAudioLibraryShuffleChange: (v: boolean) => void;
  onAudioLibraryContinuousChange: (v: boolean) => void;
}

export const LocalAudioPanel = forwardRef<LocalAudioPanelHandle, LocalAudioPanelProps>(
  function LocalAudioPanel(
    {
      onSelectTrack,
      activeLeftId,
      activeRightId,
      splitView,
      onLibraryStateChange,
      onIndexedLibraryChannelsChange,
      audioLibraryShuffle,
      audioLibraryContinuous,
      onAudioLibraryShuffleChange,
      onAudioLibraryContinuousChange,
    },
    ref
  ) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasDesktopPick = typeof window !== "undefined" && typeof window.iptv?.pickLocalAudioFiles === "function";

  useEffect(() => {
    onIndexedLibraryChannelsChange?.(rows.map((r) => channelFromLibraryTrack(r.track, r.url)));
  }, [rows, onIndexedLibraryChannelsChange]);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    void (async () => {
      try {
        const list = await listAudioLibraryTracks();
        if (cancelled) return;
        setRows((prev) => mergeIdbListIntoRows(prev, list));
        for (const t of list) {
          if (cancelled) return;
          const tagRow = await enrichRowWithFileTags(makeLibraryRow(t));
          if (!cancelled) {
            setRows((prev) => prev.map((r) => (r.track.id === t.id ? tagRow : r)));
          }
          if (t.coverArt instanceof Blob && t.coverArt.size > 0) continue;
          const next = await enrichStoredTrackWithCoverArt(t);
          const now = next.coverArt instanceof Blob && next.coverArt.size > 0;
          if (!now) continue;
          try {
            await persistStoredTrack(next);
          } catch {
            continue;
          }
          if (cancelled) return;
          setRows((prev) =>
            prev.map((r) => {
              if (r.track.id !== next.id) return r;
              revokeRow(r);
              const fresh = makeLibraryRow(next);
              return {
                ...fresh,
                tagsTooltip: r.tagsTooltip,
                tagArtist: r.tagArtist,
                tagTitle: r.tagTitle,
              };
            })
          );
          await new Promise<void>((res) => {
            window.setTimeout(() => res(), 0);
          });
        }
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enrichTagsForRows = async (toTag: LibraryRow[]) => {
    for (const row of toTag) {
      const tagged = await enrichRowWithFileTags(row);
      setRows((prev) => prev.map((r) => (r.track.id === tagged.track.id ? tagged : r)));
    }
  };

  const persistRows = async (built: StoredAudioTrack[]) => {
    const persistErrs: string[] = [];
    for (const row of built) {
      try {
        await persistStoredTrack(row);
      } catch (ex) {
        persistErrs.push(ex instanceof Error ? ex.message : String(ex));
      }
    }
    if (persistErrs.length) {
      setErr(
        `Added ${built.length} file(s) for this session, but saving the library failed: ${persistErrs[0]}. Playback still works until you close the app.`
      );
    }
  };

  const onPickBrowserFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    e.target.value = "";
    if (!files?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const built: StoredAudioTrack[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f || f.size === 0) continue;
        built.push(fileToStoredTrack(f));
      }
      if (built.length === 0) {
        setErr("No files were imported (empty selection or zero-byte files).");
        return;
      }
      const enriched: StoredAudioTrack[] = [];
      for (const t of built) {
        enriched.push(await enrichStoredTrackWithCoverArt(t));
      }
      const newIds = new Set(enriched.map((t) => t.id));
      setRows((prev) => {
        const merged = mergeIncomingTracks(prev, enriched);
        void enrichTagsForRows(merged.filter((r) => newIds.has(r.track.id)));
        return merged;
      });
      await persistRows(enriched);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onAddDesktop = async () => {
    if (!window.iptv?.pickLocalAudioFiles) return;
    setBusy(true);
    setErr(null);
    try {
      const picked = await window.iptv.pickLocalAudioFiles();
      const built: StoredAudioTrack[] = [];
      for (const item of picked) {
        const norm = normalizePickedPayload(item);
        if (!norm) continue;
        built.push(trackFromDesktopPick(norm));
      }
      if (built.length === 0) {
        setErr("No audio files were added (empty selection, unreadable paths, or zero-byte files).");
        return;
      }
      const enriched: StoredAudioTrack[] = [];
      for (const t of built) {
        enriched.push(await enrichStoredTrackWithCoverArt(t));
      }
      const newIds = new Set(enriched.map((t) => t.id));
      setRows((prev) => {
        const merged = mergeIncomingTracks(prev, enriched);
        void enrichTagsForRows(merged.filter((r) => newIds.has(r.track.id)));
        return merged;
      });
      await persistRows(enriched);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onClearAll = useCallback(async () => {
    if (rows.length === 0) return;
    const ok = window.confirm(
      `Remove all ${rows.length} file${rows.length === 1 ? "" : "s"} from the audio library? This cannot be undone.`
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const ids = rows.map((r) => r.track.id);
      await clearAudioLibrary();
      for (const r of rows) revokeRow(r);
      for (const id of ids) clearAudioResume(id);
      setRows([]);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  }, [rows]);

  useImperativeHandle(ref, () => ({ clearAll: onClearAll }), [onClearAll]);

  useEffect(() => {
    onLibraryStateChange?.({ trackCount: rows.length, busy });
  }, [rows.length, busy, onLibraryStateChange]);

  const onRemove = async (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      await removeAudioLibraryTrack(id);
      setRows((prev) => {
        const hit = prev.find((r) => r.track.id === id);
        if (hit) revokeRow(hit);
        return prev.filter((r) => r.track.id !== id);
      });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const [resumeTick, setResumeTick] = useState(0);
  const bumpResumeHints = useCallback(() => setResumeTick((n) => n + 1), []);

  useEffect(() => {
    const onFocus = () => bumpResumeHints();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [bumpResumeHints]);

  const playRow = useCallback(
    (r: LibraryRow) => {
      onSelectTrack(channelFromLibraryTrack(r.track, r.url));
      bumpResumeHints();
    },
    [onSelectTrack, bumpResumeHints]
  );

  const playFromStart = useCallback(
    (r: LibraryRow, ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      clearAudioResume(r.track.id);
      bumpResumeHints();
      onSelectTrack(channelFromLibraryTrack(r.track, r.url, { restartNonce: Date.now() }));
    },
    [onSelectTrack, bumpResumeHints]
  );

  const playResume = useCallback(
    (r: LibraryRow, ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      bumpResumeHints();
      onSelectTrack(channelFromLibraryTrack(r.track, r.url));
    },
    [onSelectTrack, bumpResumeHints]
  );

  const resumeHints = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const sec = loadAudioResumeSeconds(r.track.id);
      if (sec != null && sec >= 3) m.set(r.track.id, sec);
    }
    return m;
  }, [rows, resumeTick]);

  return (
    <div className="local-audio-root">
      <div className="local-audio-toolbar">
        {hasDesktopPick ? (
          <button type="button" className="url-btn" disabled={busy} onClick={() => void onAddDesktop()}>
            + Add files…
          </button>
        ) : (
          <label className={`file-btn local-audio-pick${busy ? " file-btn--disabled" : ""}`}>
            <input
              type="file"
              className="local-audio-file-input"
              multiple
              accept={AUDIO_ACCEPT}
              disabled={busy}
              onChange={(e) => void onPickBrowserFiles(e)}
            />
            <span className="local-audio-pick-text">+ Add from computer</span>
          </label>
        )}
        {busy ? (
          <span className="local-audio-hourglass" role="status" aria-live="polite" aria-label="Loading audio files">
            <span className="local-audio-hourglass-icon" aria-hidden>
              ⏳
            </span>
          </span>
        ) : null}
        <div className="local-audio-toolbar-playback">
          <AudioLibraryPlaybackControls
            shuffle={audioLibraryShuffle}
            continuous={audioLibraryContinuous}
            onShuffleChange={onAudioLibraryShuffleChange}
            onContinuousChange={onAudioLibraryContinuousChange}
            onClearAll={() => void onClearAll()}
            clearDisabled={busy || rows.length === 0}
          />
        </div>
      </div>

      {err ? <p className="local-audio-err">{err}</p> : null}

      <div className="local-audio-scroll">
        {rows.length === 0 ? (
          <div className="local-audio-empty">
            No files yet — <strong>{hasDesktopPick ? "Add files…" : "Add from computer"}</strong>. Imports stay in this
            profile until you remove them.
          </div>
        ) : (
          rows.map((r) => {
            const t = r.track;
            const ch = channelFromLibraryTrack(t, r.url);
            const leftOn = ch.id === activeLeftId;
            const rightOn = splitView && ch.id === activeRightId;
            const rowClass =
              leftOn || rightOn
                ? `local-audio-row active${leftOn ? " active--left" : ""}${rightOn ? " active--right" : ""}`
                : "local-audio-row";
            const resumeAt = resumeHints.get(t.id);
            const tagLine =
              r.tagArtist && r.tagTitle
                ? `${r.tagArtist} — ${r.tagTitle}`
                : r.tagTitle || r.tagArtist || "";
            const rowTooltip =
              r.tagsTooltip?.trim() ||
              (tagLine ? `Tags: ${tagLine}` : "Reading embedded file tags…");
            return (
              <div key={t.id} className={rowClass} title={rowTooltip}>
                <button
                  type="button"
                  className="local-audio-row-hit"
                  title={rowTooltip}
                  onClick={() => playRow(r)}
                >
                  {r.thumbUrl ? (
                    <img className="local-audio-thumb" src={r.thumbUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="local-audio-icon" aria-hidden>
                      ♪
                    </span>
                  )}
                  <span className="local-audio-meta">
                    <span className="local-audio-name">{t.name}</span>
                    {tagLine ? <span className="local-audio-tag-line">{tagLine}</span> : null}
                  </span>
                </button>
                <div className="local-audio-row-actions" aria-label="Playback">
                  <button
                    type="button"
                    className="local-audio-pos-btn"
                    title="Start from beginning"
                    aria-label={`Start ${t.name} from beginning`}
                    disabled={busy}
                    onClick={(ev) => playFromStart(r, ev)}
                  >
                    <span className="local-audio-pos-glyph" aria-hidden>
                      ↺
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`local-audio-pos-btn local-audio-pos-btn--resume${resumeAt != null ? " local-audio-pos-btn--has-time" : ""}`}
                    title={resumeAt != null ? `Resume at ${formatResume(resumeAt)}` : "No saved position yet"}
                    aria-label={
                      resumeAt != null
                        ? `Resume ${t.name} at ${formatResume(resumeAt)}`
                        : `Resume ${t.name} (no saved position)`
                    }
                    disabled={busy || resumeAt == null}
                    onClick={(ev) => playResume(r, ev)}
                  >
                    <span className="local-audio-pos-glyph" aria-hidden>
                      ▶
                    </span>
                    {resumeAt != null ? (
                      <span className="local-audio-pos-time">{formatResume(resumeAt)}</span>
                    ) : null}
                  </button>
                </div>
                <button
                  type="button"
                  className="local-audio-del"
                  title="Remove from library"
                  aria-label={`Remove ${t.name}`}
                  disabled={busy}
                  onClick={(ev) => void onRemove(t.id, ev)}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <details className="local-audio-translate-details">
        <summary className="local-audio-translate-summary">
          Lyrics translation — LLM API (optional)
        </summary>
        <div className="local-audio-translate-details-body">
          <LyricsChatTranslateSettings />
        </div>
      </details>
    </div>
  );
});
