import { formatAudioTagsTooltip } from "./formatAudioTagsTooltip";

/** Bytes scanned from the start of the file for ID3 / MP4 / Vorbis tags. */
const SCAN_BYTES = 512 * 1024;

export interface AudioFileMetadata {
  title: string;
  artist: string;
  album: string;
}

export interface AudioTagField {
  label: string;
  value: string;
}

export interface ExtractedAudioTags extends AudioFileMetadata {
  fields: AudioTagField[];
  tooltip: string;
}

const ID3V24_LABELS: Record<string, string> = {
  TIT2: "Title",
  TIT1: "Content group",
  TPE1: "Artist",
  TPE2: "Album artist",
  TPE3: "Conductor",
  TPE4: "Remixer",
  TALB: "Album",
  TAL: "Album",
  TRCK: "Track",
  TPOS: "Disc",
  TYER: "Year",
  TDRC: "Date",
  TCON: "Genre",
  TCOM: "Composer",
  TENC: "Encoded by",
  TPUB: "Publisher",
  TLAN: "Language",
  TBPM: "BPM",
  TKEY: "Key",
  COMM: "Comment",
  USLT: "Lyrics",
};

const ID3V22_LABELS: Record<string, string> = {
  TT2: "Title",
  TP1: "Artist",
  TP2: "Album artist",
  TAL: "Album",
  TRK: "Track",
  TYE: "Year",
  TCO: "Genre",
  TCM: "Composer",
  TEN: "Encoded by",
};

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

function readUInt32LE(u: Uint8Array, offset: number): number {
  return (
    (u[offset]! | (u[offset + 1]! << 8) | (u[offset + 2]! << 16) | (u[offset + 3]! << 24)) >>> 0
  );
}

function readUInt24BE(u: Uint8Array, offset: number): number {
  return (u[offset]! << 16) | (u[offset + 1]! << 8) | u[offset + 2]!;
}

function extensionFromName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function decodeId3TextFrame(data: Uint8Array): string {
  if (!data.length) return "";
  const enc = data[0]!;
  const body = data.subarray(1);
  if (enc === 0) {
    let end = body.length;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0) {
        end = i;
        break;
      }
    }
    return new TextDecoder("latin1").decode(body.subarray(0, end)).trim();
  }
  if (enc === 1 || enc === 2) {
    const dec = enc === 1 ? "utf-16" : "utf-16be";
    return new TextDecoder(dec).decode(body).replace(/\0/g, "").trim();
  }
  if (enc === 3) {
    let end = body.length;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0) {
        end = i;
        break;
      }
    }
    return new TextDecoder("utf-8").decode(body.subarray(0, end)).trim();
  }
  return new TextDecoder("utf-8").decode(body).trim();
}

function id3FrameLabel(id: string, major: number): string {
  if (major === 2) return ID3V22_LABELS[id] ?? id;
  return ID3V24_LABELS[id] ?? id;
}

function pushField(fields: AudioTagField[], label: string, value: string): void {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return;
  if (fields.some((f) => f.label === label && f.value === v)) return;
  fields.push({ label, value: v });
}

function summaryFromFields(fields: AudioTagField[]): Pick<AudioFileMetadata, "title" | "artist" | "album"> {
  const pick = (...labels: string[]) => {
    for (const label of labels) {
      const hit = fields.find((f) => f.label === label);
      if (hit?.value.trim()) return hit.value.trim();
    }
    return "";
  };
  const title =
    pick("Title") ||
    fields.find((f) => /^title$/i.test(f.label))?.value.trim() ||
    "";
  const artist = pick("Artist") || pick("Artists") || pick("Album artist");
  const album = pick("Album");
  return { title, artist, album };
}

/** ID3v1 tag at end of file (128 bytes, starts with `TAG`). */
function extractId3v1Fields(tail: Uint8Array): AudioTagField[] {
  if (tail.length < 128) return [];
  const off = tail.length - 128;
  if (tail[off] !== 0x54 || tail[off + 1] !== 0x41 || tail[off + 2] !== 0x47) return [];

  const readFixed = (start: number, len: number) => {
    const slice = tail.subarray(off + start, off + start + len);
    return new TextDecoder("latin1").decode(slice).replace(/\0/g, " ").trim();
  };

  const fields: AudioTagField[] = [];
  pushField(fields, "Title", readFixed(3, 30));
  pushField(fields, "Artist", readFixed(33, 30));
  pushField(fields, "Album", readFixed(63, 30));
  pushField(fields, "Year", readFixed(93, 4));
  pushField(fields, "Comment", readFixed(97, 30));
  const genre = tail[off + 127]!;
  if (genre !== 0 && genre !== 255) pushField(fields, "Genre", String(genre));
  return fields;
}

/** ID3v2 text / comment frames (v2.2, v2.3, v2.4). */
function extractId3v2Fields(buf: Uint8Array): AudioTagField[] {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return [];
  const major = buf[3]!;
  if (major !== 2 && major !== 3 && major !== 4) return [];

  const flags = buf[5]!;
  let pos = 10;
  const tagSize =
    major === 4 || major === 3 ? readSyncsafeUint28(buf, 6) : readUInt24BE(buf, 6);
  const tagEnd = Math.min(buf.length, 10 + tagSize);

  if ((flags & 0x40) !== 0 && major === 4) {
    if (pos + 4 > tagEnd) return [];
    const extSize = readSyncsafeUint28(buf, pos);
    pos += 4 + extSize;
  }

  const fields: AudioTagField[] = [];
  const idLen = major === 2 ? 3 : 4;

  while (pos + idLen + 4 <= tagEnd) {
    const id = String.fromCharCode(...buf.subarray(pos, pos + idLen));
    let frameSize: number;
    let dataStart: number;
    if (major === 2) {
      frameSize = readUInt24BE(buf, pos + 3);
      dataStart = pos + 6;
    } else {
      frameSize = major === 4 ? readSyncsafeUint28(buf, pos + 4) : readUInt32BE(buf, pos + 4);
      dataStart = pos + 10;
    }
    const dataEnd = dataStart + frameSize;
    if (dataEnd > tagEnd || frameSize < 0) break;

    if (id === "COMM" || id === "COM") {
      const payload = buf.subarray(dataStart, dataEnd);
      if (payload.length > 4) {
        const text = decodeId3TextFrame(payload.subarray(4));
        pushField(fields, id3FrameLabel(id, major), text);
      }
    } else if (id.startsWith("T") || id === "TXXX") {
      const text = decodeId3TextFrame(buf.subarray(dataStart, dataEnd));
      pushField(fields, id3FrameLabel(id, major), text);
    }

    pos = dataEnd;
    if (id === "\0\0\0\0" || id === "\0\0\0") break;
  }

  return fields;
}

function readMp4Utf8Data(payload: Uint8Array): string {
  if (payload.length < 8) return "";
  const type = readUInt32BE(payload, 0);
  if (type !== 1) return "";
  return new TextDecoder("utf-8").decode(payload.subarray(4)).replace(/\0/g, "").trim();
}

function extractMp4Fields(buf: Uint8Array): AudioTagField[] {
  const fields: AudioTagField[] = [];
  const findIn = (hay: Uint8Array, a: number, b: number, c: number, d: number): number => {
    for (let i = 0; i < hay.length - 4; i++) {
      if (hay[i] === a && hay[i + 1] === b && hay[i + 2] === c && hay[i + 3] === d) return i;
    }
    return -1;
  };
  const readIlstItem = (at: number, label: string) => {
    if (at < 4) return;
    const boxStart = at - 4;
    const boxSize = readUInt32BE(buf, boxStart);
    if (boxSize < 16 || boxStart + boxSize > buf.length) return;
    const slice = buf.subarray(boxStart + 8, boxStart + boxSize);
    const dataAt = findIn(slice, 0x64, 0x61, 0x74, 0x61);
    if (dataAt < 0 || dataAt + 12 > slice.length) return;
    const text = readMp4Utf8Data(slice.subarray(dataAt + 8));
    pushField(fields, label, text);
  };
  readIlstItem(findIn(buf, 0xa9, 0x6e, 0x61, 0x6d), "Title");
  readIlstItem(findIn(buf, 0xa9, 0x41, 0x52, 0x54), "Artist");
  readIlstItem(findIn(buf, 0xa9, 0x61, 0x6c, 0x62), "Album");
  return fields;
}

function vorbisLabel(key: string): string {
  const k = key.trim().toUpperCase();
  const map: Record<string, string> = {
    TITLE: "Title",
    ARTIST: "Artist",
    ARTISTS: "Artists",
    ALBUM: "Album",
    ALBUMARTIST: "Album artist",
    DATE: "Date",
    YEAR: "Year",
    GENRE: "Genre",
    TRACKNUMBER: "Track",
    TRACK: "Track",
    DISCNUMBER: "Disc",
    COMPOSER: "Composer",
    COMMENT: "Comment",
    DESCRIPTION: "Description",
    LYRICS: "Lyrics",
  };
  return map[k] ?? key.trim();
}

function extractFlacVorbisFields(buf: Uint8Array): AudioTagField[] {
  if (buf.length < 8 || buf[0] !== 0x66 || buf[1] !== 0x4c || buf[2] !== 0x61 || buf[3] !== 0x43) return [];
  const fields: AudioTagField[] = [];
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const byte0 = buf[pos]!;
    const isLast = (byte0 & 0x80) !== 0;
    const blockType = byte0 & 0x7f;
    const blockLen = (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!;
    pos += 4;
    const end = pos + blockLen;
    if (end > buf.length) break;
    if (blockType === 4) {
      const b = buf.subarray(pos, end);
      if (b.length < 8) break;
      let o = 0;
      const vendorLen = readUInt32LE(b, o);
      o += 4 + vendorLen;
      if (o + 4 > b.length) break;
      const count = readUInt32LE(b, o);
      o += 4;
      for (let i = 0; i < count && o + 4 <= b.length; i++) {
        const len = readUInt32LE(b, o);
        o += 4;
        if (o + len > b.length) break;
        const line = new TextDecoder("utf-8").decode(b.subarray(o, o + len)).trim();
        o += len;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        pushField(fields, vorbisLabel(key), val);
      }
    }
    pos = end;
    if (isLast) break;
  }
  return fields;
}

function isFlacMagic(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43;
}

/**
 * All embedded tags (ID3v2, ID3v1, FLAC Vorbis, MP4) plus tooltip text.
 */
export async function extractAudioTagsDetailed(blob: Blob, fileName: string): Promise<ExtractedAudioTags> {
  const ext = extensionFromName(fileName);
  const fields: AudioTagField[] = [];

  const headN = Math.min(blob.size, SCAN_BYTES);
  const head =
    headN > 0 ? new Uint8Array(await blob.slice(0, headN).arrayBuffer()) : new Uint8Array(0);

  let tail = new Uint8Array(0);
  if (blob.size >= 128) {
    tail = new Uint8Array(await blob.slice(blob.size - 128).arrayBuffer());
  }

  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    for (const f of extractId3v2Fields(head)) pushField(fields, f.label, f.value);
  }
  for (const f of extractId3v1Fields(tail)) pushField(fields, f.label, f.value);

  if (isFlacMagic(head) || ext === ".flac") {
    for (const f of extractFlacVorbisFields(head)) pushField(fields, f.label, f.value);
  }

  if (
    ext === ".m4a" ||
    ext === ".m4b" ||
    ext === ".mp4" ||
    (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70)
  ) {
    for (const f of extractMp4Fields(head)) pushField(fields, f.label, f.value);
  }

  if (ext === ".mp3" && fields.length === 0 && head.length >= 10) {
    for (const f of extractId3v2Fields(head)) pushField(fields, f.label, f.value);
  }

  const summary = summaryFromFields(fields);
  const tooltip = formatAudioTagsTooltip(fields, {
    fileName,
    emptyHint: "No ID3 or Vorbis tags found in the first part of this file.",
  });

  return {
    title: summary.title,
    artist: summary.artist,
    album: summary.album,
    fields,
    tooltip,
  };
}

/**
 * Best-effort title / artist / album from ID3v2 (MP3), Vorbis comments (FLAC), or MP4 tags (M4A/M4B).
 */
export async function extractAudioMetadata(blob: Blob, fileName: string): Promise<AudioFileMetadata> {
  const d = await extractAudioTagsDetailed(blob, fileName);
  return { title: d.title, artist: d.artist, album: d.album };
}
