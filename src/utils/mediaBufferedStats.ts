/** Seconds of media buffered ahead of `currentTime` (MSE / HLS / progressive). */
export function getBufferedAheadSec(media: HTMLMediaElement): number {
  const t = media.currentTime;
  const b = media.buffered;
  if (!b?.length) return 0;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t && t <= b.end(i)) {
      return Math.max(0, b.end(i) - t);
    }
  }
  let best = 0;
  for (let i = 0; i < b.length; i++) {
    if (b.end(i) > t) best = Math.max(best, b.end(i) - t);
  }
  return best;
}

export function formatBufferStatsLine(parts: {
  aheadSec: number;
  fillSs: number;
  levelKbps: number | null;
}): string {
  const a = parts.aheadSec < 999 ? parts.aheadSec.toFixed(1) : "999+";
  const bits: string[] = [`buffer ${a}s`];
  if (Number.isFinite(parts.fillSs) && Math.abs(parts.fillSs) > 0.001) {
    const sign = parts.fillSs > 0 ? "+" : "";
    bits.push(`rate ${sign}${parts.fillSs.toFixed(2)} s/s`);
  }
  if (parts.levelKbps != null && parts.levelKbps > 0) {
    if (parts.levelKbps >= 10000) bits.push(`~${(parts.levelKbps / 1000).toFixed(1)} Mb/s`);
    else bits.push(`~${Math.round(parts.levelKbps)} kb/s`);
  }
  return bits.join(" · ");
}
