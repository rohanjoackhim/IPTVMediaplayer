/** Max bytes read from the start of a file for tag/metadata scanning (covers live in headers). */
const SCAN_BYTES = 768 * 1024;

/** Stored cover is capped to keep IndexedDB lean. */
const MAX_STORED_COVER_BYTES = 512 * 1024;

export interface ExtractedCover {
  blob: Blob;
  mime: string;
}

function readSyncsafeUint28(u: Uint8Array, offset: number): number {
  return (
    ((u[offset]! & 0x7f) << 21) |
    ((u[offset + 1]! & 0x7f) << 14) |
    ((u[offset + 2]! & 0x7f) << 7) |
    (u[offset + 3]! & 0x7f)
  );
}

function readUInt32BE(u: Uint8Array, offset: number): number {
  return (
    (u[offset]! << 24) | (u[offset + 1]! << 16) | (u[offset + 2]! << 8) | u[offset + 3]!
  ) >>> 0;
}

function trimCover(data: Uint8Array, mime: string): ExtractedCover | null {
  if (data.length < 4) return null;
  const n = Math.min(data.length, MAX_STORED_COVER_BYTES);
  const slice = data.byteOffset === 0 && data.byteLength === n ? data : data.subarray(0, n);
  const blob = new Blob([slice], { type: mime || "image/jpeg" });
  return { blob, mime: mime || "image/jpeg" };
}

/** ID3v2.3 / v2.4 APIC frame (embedded cover). */
function extractMp3Id3Apic(buf: Uint8Array): ExtractedCover | null {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const major = buf[3]!;
  if (major !== 3 && major !== 4) return null;
  const flags = buf[5]!;
  let pos = 10;
  let tagSize = readSyncsafeUint28(buf, 6);
  const tagEnd = Math.min(buf.length, 10 + tagSize);
  if (flags & 0x40 && major === 4) {
    if (pos + 4 > tagEnd) return null;
    const extSize = readSyncsafeUint28(buf, pos);
    pos += 4 + extSize;
  }
  while (pos + 10 <= tagEnd) {
    const id = String.fromCharCode(buf[pos]!, buf[pos + 1]!, buf[pos + 2]!, buf[pos + 3]!);
    let frameSize: number;
    let headerLen: number;
    if (major === 4) {
      frameSize = readSyncsafeUint28(buf, pos + 4);
      headerLen = 10;
    } else {
      frameSize = readUInt32BE(buf, pos + 4);
      headerLen = 10;
    }
    const dataStart = pos + headerLen;
    const dataEnd = dataStart + frameSize;
    if (dataEnd > tagEnd || frameSize < 0) break;
    if (id === "APIC") {
      const fd = buf.subarray(dataStart, dataEnd);
      if (fd.length < 4) return null;
      const enc = fd[0]!;
      let i = 1;
      const mimeEnd = fd.indexOf(0, i);
      if (mimeEnd <= i) return null;
      const mime = new TextDecoder("latin1").decode(fd.subarray(i, mimeEnd));
      i = mimeEnd + 1;
      if (i >= fd.length) return null;
      i += 1;
      if (enc === 1 || enc === 2) {
        while (i + 1 < fd.length && !(fd[i] === 0 && fd[i + 1] === 0)) i += 2;
        i += 2;
      } else {
        const descEnd = fd.indexOf(0, i);
        if (descEnd < 0) return null;
        i = descEnd + 1;
      }
      const img = fd.subarray(i);
      const m = mime.trim().toLowerCase() || "image/jpeg";
      return trimCover(img, m.startsWith("image/") ? m : "image/jpeg");
    }
    pos = dataEnd;
    if (id === "\0\0\0\0") break;
  }
  return null;
}

/** FLAC METADATA_BLOCK_PICTURE (type 6). */
function extractFlacPicture(buf: Uint8Array): ExtractedCover | null {
  if (buf.length < 8 || buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return null;
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const byte0 = buf[pos]!;
    const last = (byte0 & 0x80) !== 0;
    const blockType = byte0 & 0x7f;
    const blockLen = (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!;
    pos += 4;
    const end = pos + blockLen;
    if (end > buf.length) break;
    if (blockType === 6) {
      const b = buf.subarray(pos, end);
      if (b.length < 32) return null;
      let o = 0;
      const mimeLen = readUInt32BE(b, o);
      o += 4;
      if (o + mimeLen > b.length) return null;
      const mime = new TextDecoder("utf-8").decode(b.subarray(o, o + mimeLen));
      o += mimeLen;
      if (o + 4 > b.length) return null;
      const descLen = readUInt32BE(b, o);
      o += 4;
      if (o + descLen + 20 > b.length) return null;
      o += descLen;
      o += 4 + 4 + 4 + 4 + 4;
      if (o + 4 > b.length) return null;
      const picLen = readUInt32BE(b, o);
      o += 4;
      if (o + picLen > b.length || picLen < 8) return null;
      const img = b.subarray(o, o + picLen);
      const m = mime.trim().toLowerCase() || "image/jpeg";
      return trimCover(img, m.startsWith("image/") ? m : "image/jpeg");
    }
    pos = end;
    if (last) break;
  }
  return null;
}

/** MP4/M4A: find `covr` / `COVR` ilst data image (JPEG or PNG). */
function extractMp4Covr(buf: Uint8Array): ExtractedCover | null {
  const u = buf;
  const find = (a: number, b: number, c: number, d: number) => {
    for (let i = 4; i < u.length - 8; i++) {
      if (u[i] === a && u[i + 1] === b && u[i + 2] === c && u[i + 3] === d) return i;
    }
    return -1;
  };
  let covrAt = find(0x63, 0x6f, 0x76, 0x72);
  if (covrAt < 0) covrAt = find(0x43, 0x4f, 0x56, 0x52);
  if (covrAt < 0) return null;
  let p = covrAt - 4;
  if (p < 0) return null;
  const boxSize = readUInt32BE(u, p);
  if (boxSize < 16 || p + boxSize > u.length) return null;
  const boxEnd = p + boxSize;
  p += 8;
  while (p + 8 <= boxEnd) {
    const sz = readUInt32BE(u, p);
    const typ = String.fromCharCode(u[p + 4]!, u[p + 5]!, u[p + 6]!, u[p + 7]!);
    if (sz < 8 || p + sz > boxEnd) break;
    if (typ === "data" && sz > 16) {
      const fmt = readUInt32BE(u, p + 8);
      const payload = u.subarray(p + 16, p + sz);
      if (payload.length < 8) break;
      const mime = fmt === 13 ? "image/png" : "image/jpeg";
      return trimCover(payload, mime);
    }
    p += sz;
  }
  return null;
}

function extensionFromName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/**
 * Best-effort embedded album art from ID3v2 (MP3), FLAC picture block, or MP4 `covr`.
 * Reads only the first ~768 KiB of `blob`.
 */
export async function extractEmbeddedCoverArt(blob: Blob, fileName: string): Promise<ExtractedCover | null> {
  const ext = extensionFromName(fileName);
  const n = Math.min(blob.size, SCAN_BYTES);
  if (n < 16) return null;
  const ab = await blob.slice(0, n).arrayBuffer();
  const buf = new Uint8Array(ab);

  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const apic = extractMp3Id3Apic(buf);
    if (apic) return apic;
  }
  if (ext === ".flac" || (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43)) {
    const fl = extractFlacPicture(buf);
    if (fl) return fl;
  }
  if (
    ext === ".m4a" ||
    ext === ".m4b" ||
    ext === ".mp4" ||
    ext === ".aac" ||
    (buf.length >= 12 &&
      buf[4] === 0x66 &&
      buf[5] === 0x74 &&
      buf[6] === 0x79 &&
      buf[7] === 0x70)
  ) {
    const c = extractMp4Covr(buf);
    if (c) return c;
  }
  if (ext === ".mp3") {
    const apic = extractMp3Id3Apic(buf);
    if (apic) return apic;
  }
  return null;
}
