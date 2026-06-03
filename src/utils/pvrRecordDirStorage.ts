const PVR_RECORD_DIR_KEY = "iptv-pvr-record-dir";

export function loadPvrRecordDir(): string | null {
  try {
    const raw = localStorage.getItem(PVR_RECORD_DIR_KEY);
    const dir = typeof raw === "string" ? raw.trim() : "";
    return dir || null;
  } catch {
    return null;
  }
}

export function savePvrRecordDir(dir: string | null): void {
  try {
    const trimmed = dir?.trim() ?? "";
    if (!trimmed) {
      localStorage.removeItem(PVR_RECORD_DIR_KEY);
      return;
    }
    localStorage.setItem(PVR_RECORD_DIR_KEY, trimmed);
  } catch {
    /* quota */
  }
}
