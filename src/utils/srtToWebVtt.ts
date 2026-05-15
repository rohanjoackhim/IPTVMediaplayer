/** Minimal SRT → WebVTT for browser <track> (timestamps must be valid). */
export function srtToWebVtt(srt: string): string {
  const normalized = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.trim().split(/\n\n+/);
  const cues: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length < 2) continue;

    let timeLineIdx = 0;
    if (/^\d+$/.test(lines[0].trim())) timeLineIdx = 1;
    const timeLine = lines[timeLineIdx];
    const m = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
    );
    if (!m) continue;
    const start = m[1].replace(",", ".");
    const end = m[2].replace(",", ".");
    const textLines = lines.slice(timeLineIdx + 1).join("\n");
    cues.push(`${start} --> ${end}\n${textLines}`);
  }

  return "WEBVTT\n\n" + cues.join("\n\n");
}
