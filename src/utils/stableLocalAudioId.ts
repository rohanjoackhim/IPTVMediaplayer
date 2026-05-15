export interface StableLocalAudioMeta {
  /**
   * Full file name including extension (same string as `File.name` from a file picker).
   * Not a full path.
   */
  fileName: string;
  size: number;
  lastModified: number;
}

/** Deterministic id for a local file (fileName + size + lastModified). */
export function stableLocalAudioIdFromMeta(meta: StableLocalAudioMeta): string {
  const raw = `${meta.fileName}\0${meta.size}\0${meta.lastModified}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `lib-${(h >>> 0).toString(16)}-${meta.size}-${meta.lastModified}`;
}

/** Deterministic id for a local file (name + size + lastModified). */
export function stableLocalAudioId(file: Pick<File, "name" | "size" | "lastModified">): string {
  return stableLocalAudioIdFromMeta({
    fileName: file.name,
    size: file.size,
    lastModified: file.lastModified,
  });
}
