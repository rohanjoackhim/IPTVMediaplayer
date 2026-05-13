import { useCallback, useEffect, useMemo, useState } from "react";
import type { Channel } from "../types";
import { loadAudioResumeSeconds } from "../utils/audioResumeStorage";
import {
  channelFromLibraryTrack,
  fileToStoredTrack,
  listAudioLibraryTracks,
  persistStoredTrack,
  removeAudioLibraryTrack,
  trackFromDesktopPick,
  type PickedLocalAudioPayload,
  type StoredAudioTrack,
} from "../utils/audioLibraryDb";
import "./LocalAudioPanel.css";

const AUDIO_ACCEPT =
  "audio/*,.mp3,.m4a,.m4b,.aac,.ogg,.oga,.opus,.wav,.flac,.webm,.mpeg,.mpga,application/octet-stream";

type LibraryRow = { track: StoredAudioTrack; url: string };

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

function sortRows(rows: LibraryRow[]): LibraryRow[] {
  return [...rows].sort((a, b) =>
    a.track.name.localeCompare(b.track.name, undefined, { sensitivity: "base" })
  );
}

function mergeIncomingTracks(prev: LibraryRow[], incoming: StoredAudioTrack[]): LibraryRow[] {
  const m = new Map(prev.map((r) => [r.track.id, r]));
  for (const t of incoming) {
    const old = m.get(t.id);
    if (old) revokeUrl(old.url);
    if (!(t.blob instanceof Blob)) continue;
    m.set(t.id, { track: t, url: URL.createObjectURL(t.blob) });
  }
  return sortRows(Array.from(m.values()));
}

function rowsFromIdbTracks(list: StoredAudioTrack[]): LibraryRow[] {
  const out: LibraryRow[] = [];
  for (const t of list) {
    if (!(t.blob instanceof Blob)) continue;
    out.push({ track: t, url: URL.createObjectURL(t.blob) });
  }
  return sortRows(out);
}

function mergeIdbListIntoRows(prev: LibraryRow[], list: StoredAudioTrack[]): LibraryRow[] {
  const fromDb = rowsFromIdbTracks(list);
  const dbIds = new Set(fromDb.map((r) => r.track.id));
  for (const p of prev) {
    if (dbIds.has(p.track.id)) revokeUrl(p.url);
  }
  const kept = prev.filter((p) => !dbIds.has(p.track.id));
  return sortRows([...fromDb, ...kept]);
}

function normalizePickedPayload(raw: unknown): PickedLocalAudioPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
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
  if (!id || !data || size === 0) return null;
  return { id, name, size, lastModified, addedAt, mime, data };
}

export interface LocalAudioPanelProps {
  onSelectTrack: (c: Channel) => void;
  activeLeftId: string | null;
  activeRightId: string | null;
  splitView: boolean;
}

export function LocalAudioPanel({
  onSelectTrack,
  activeLeftId,
  activeRightId,
  splitView,
}: LocalAudioPanelProps) {
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasDesktopPick = typeof window !== "undefined" && typeof window.iptv?.pickLocalAudioFiles === "function";

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    void (async () => {
      try {
        const list = await listAudioLibraryTracks();
        if (cancelled) return;
        setRows((prev) => mergeIdbListIntoRows(prev, list));
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
      setRows((prev) => mergeIncomingTracks(prev, built));
      await persistRows(built);
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
      setRows((prev) => mergeIncomingTracks(prev, built));
      await persistRows(built);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      await removeAudioLibraryTrack(id);
      setRows((prev) => {
        const hit = prev.find((r) => r.track.id === id);
        if (hit) revokeUrl(hit.url);
        return prev.filter((r) => r.track.id !== id);
      });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
    } finally {
      setBusy(false);
    }
  };

  const playRow = useCallback(
    (r: LibraryRow) => {
      onSelectTrack(channelFromLibraryTrack(r.track, r.url));
    },
    [onSelectTrack]
  );

  const resumeHints = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const sec = loadAudioResumeSeconds(r.track.id);
      if (sec != null && sec >= 3) m.set(r.track.id, sec);
    }
    return m;
  }, [rows]);

  return (
    <div className="local-audio-root">
      <header className="local-audio-header">
        <h2 className="local-audio-title">MP3 & audiobooks</h2>
        <p className="local-audio-sub">
          {hasDesktopPick
            ? "Desktop: files are read by the app and stored in IndexedDB for resume and quick reopen. Playback uses the right player (split view turns on automatically)."
            : "Browser build: choose files here; they are stored in IndexedDB in this profile. Playback uses the right player."}
        </p>
      </header>

      <div className="local-audio-toolbar">
        {hasDesktopPick ? (
          <button type="button" className="url-btn" disabled={busy} onClick={() => void onAddDesktop()}>
            + Add files…
          </button>
        ) : null}
        {!hasDesktopPick ? (
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
            <span className="local-audio-pick-text">+ Add via browser picker</span>
          </label>
        )}
        {busy ? <span className="browser-sub">Working…</span> : null}
        {hasDesktopPick ? (
          <p className="local-audio-toolbar-hint">
            Prefer <strong>Add files…</strong> on Windows for the most reliable imports (large M4B/MP3).
          </p>
        ) : null}
      </div>

      {err ? <p className="local-audio-err">{err}</p> : null}

      <div className="local-audio-scroll">
        {rows.length === 0 ? (
          <div className="local-audio-empty">
            No files yet. Use <strong>{hasDesktopPick ? "Add files…" : "Add from computer"}</strong> to import MP3s
            or audiobooks. They stay in this browser until you remove them.
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
            return (
              <div key={t.id} className={rowClass}>
                <button type="button" className="local-audio-row-hit" onClick={() => playRow(r)}>
                  <span className="local-audio-icon" aria-hidden>
                    ♪
                  </span>
                  <span className="local-audio-meta">
                    <span className="local-audio-name">{t.name}</span>
                    {resumeAt != null ? (
                      <span className="local-audio-resume">Resume at {formatResume(resumeAt)}</span>
                    ) : (
                      <span className="local-audio-resume" style={{ opacity: 0.5 }}>
                        Start from beginning
                      </span>
                    )}
                  </span>
                </button>
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
    </div>
  );
}
