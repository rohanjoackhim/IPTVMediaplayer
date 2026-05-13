/** Deterministic id for a local file (name + size + lastModified). */
export function stableLocalAudioId(file: Pick<File, "name" | "size" | "lastModified">): string {
  const raw = `${file.name}\0${file.size}\0${file.lastModified}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `lib-${(h >>> 0).toString(16)}-${file.size}-${file.lastModified}`;
}
