const PREFIX = "iptv-audio-pos:";

function key(trackId: string): string {
  return `${PREFIX}${trackId}`;
}

export function loadAudioResumeSeconds(trackId: string): number | null {
  try {
    const raw = localStorage.getItem(key(trackId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveAudioResumeSeconds(trackId: string, seconds: number): void {
  try {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    localStorage.setItem(key(trackId), String(Math.floor(seconds)));
  } catch {
    /* quota */
  }
}

export function clearAudioResume(trackId: string): void {
  try {
    localStorage.removeItem(key(trackId));
  } catch {
    /* noop */
  }
}
