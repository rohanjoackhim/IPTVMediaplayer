const PREFIX = "iptv-local-video-pos:";

function key(channelId: string): string {
  return `${PREFIX}${channelId}`;
}

export function loadVideoResumeSeconds(channelId: string): number | null {
  try {
    const raw = localStorage.getItem(key(channelId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveVideoResumeSeconds(channelId: string, seconds: number): void {
  try {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    localStorage.setItem(key(channelId), String(Math.floor(seconds)));
  } catch {
    /* quota */
  }
}

export function clearVideoResume(channelId: string): void {
  try {
    localStorage.removeItem(key(channelId));
  } catch {
    /* noop */
  }
}
