/** Turn synced LRC text into plain lines (drops leading timestamps). */
export function stripLrcTimestamps(synced: string): string {
  return synced
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\[[\d:.]+\]\s*)+/, "").trimEnd())
    .join("\n");
}
