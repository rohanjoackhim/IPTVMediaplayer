import type { AudioTagField } from "./extractAudioMetadata";

/** Multi-line native tooltip text from extracted tag fields. */
export function formatAudioTagsTooltip(
  fields: AudioTagField[],
  opts?: { fileName?: string; emptyHint?: string }
): string {
  const lines: string[] = [];
  const fileName = opts?.fileName?.trim();
  if (fileName) lines.push(`File: ${fileName}`);

  if (fields.length === 0) {
    lines.push(opts?.emptyHint ?? "No embedded tags found in this file.");
    return lines.join("\n");
  }

  lines.push("— Embedded tags —");
  for (const f of fields) {
    const val = f.value.replace(/\s+/g, " ").trim();
    if (!val) continue;
    lines.push(`${f.label}: ${val}`);
  }
  return lines.join("\n");
}
