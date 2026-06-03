import { useCallback } from "react";
import "./PvrRecordDirBar.css";

export interface PvrRecordDirBarProps {
  recordDir: string | null;
  onRecordDirChange: (dir: string | null) => void;
  canPickDir: boolean;
}

function shortenDir(path: string, max = 52): string {
  const p = path.trim();
  if (p.length <= max) return p;
  const head = Math.floor(max * 0.45);
  const tail = max - head - 1;
  return `${p.slice(0, head)}…${p.slice(-tail)}`;
}

export function PvrRecordDirBar({ recordDir, onRecordDirChange, canPickDir }: PvrRecordDirBarProps) {
  const pickDir = useCallback(async () => {
    if (!window.iptv?.pickRecordDir) return;
    const dir = await window.iptv.pickRecordDir();
    if (dir?.trim()) onRecordDirChange(dir.trim());
  }, [onRecordDirChange]);

  return (
    <div className="pvr-record-dir-bar">
      <span className="pvr-record-dir-label">Save folder</span>
      {recordDir ? (
        <code className="pvr-record-dir-path" title={recordDir}>
          {shortenDir(recordDir)}
        </code>
      ) : (
        <span className="pvr-record-dir-missing">Not set — choose a folder before scheduling PVR</span>
      )}
      <div className="pvr-record-dir-actions">
        {canPickDir ? (
          <button type="button" className="pvr-record-dir-btn" onClick={() => void pickDir()}>
            {recordDir ? "Change" : "Choose folder"}
          </button>
        ) : null}
        {recordDir ? (
          <button type="button" className="pvr-record-dir-btn pvr-record-dir-btn--clear" onClick={() => onRecordDirChange(null)}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
