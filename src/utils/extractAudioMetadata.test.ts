import { describe, expect, it } from "vitest";
import { extractAudioMetadata, extractAudioTagsDetailed } from "./extractAudioMetadata";

function id3Tag(frames: { id: string; text: string }[]): Uint8Array {
  const parts: number[] = [];
  for (const f of frames) {
    const enc = 3;
    const textBytes = new TextEncoder().encode(f.text);
    const body = new Uint8Array(1 + textBytes.length);
    body[0] = enc;
    body.set(textBytes, 1);
    const frameSize = body.length;
    parts.push(
      ...[...f.id].map((c) => c.charCodeAt(0)),
      (frameSize >> 21) & 0x7f,
      (frameSize >> 14) & 0x7f,
      (frameSize >> 7) & 0x7f,
      frameSize & 0x7f,
      0,
      0,
      ...body
    );
  }
  const frameBytes = new Uint8Array(parts);
  const tagSize = frameBytes.length;
  const header = new Uint8Array(10 + frameBytes.length);
  header.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0], 0);
  header[6] = (tagSize >> 21) & 0x7f;
  header[7] = (tagSize >> 14) & 0x7f;
  header[8] = (tagSize >> 7) & 0x7f;
  header[9] = tagSize & 0x7f;
  header.set(frameBytes, 10);
  return header;
}

function flacVorbisCommentBlock(comments: string[]): Uint8Array {
  const enc = new TextEncoder();
  const vendor = enc.encode("test");
  const vendorLen = new Uint8Array(4);
  new DataView(vendorLen.buffer).setUint32(0, vendor.length, true);
  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, comments.length, true);
  const body: number[] = [...vendorLen, ...vendor, ...countBytes];
  const lenBuf = new Uint8Array(4);
  const lenDv = new DataView(lenBuf.buffer);
  for (const c of comments) {
    const bytes = enc.encode(c);
    lenDv.setUint32(0, bytes.length, true);
    body.push(...lenBuf, ...bytes);
  }
  const block = new Uint8Array(body.length);
  block.set(body);
  const blockLen = block.length;
  const out = new Uint8Array(8 + blockLen);
  out.set([0x66, 0x4c, 0x61, 0x43], 0);
  out[4] = 0x84; // last metadata block, type 4 (Vorbis comment)
  out[5] = (blockLen >> 16) & 0xff;
  out[6] = (blockLen >> 8) & 0xff;
  out[7] = blockLen & 0xff;
  out.set(block, 8);
  return out;
}

describe("extractAudioMetadata", () => {
  it("reads ID3 title and artist", async () => {
    const buf = id3Tag([
      { id: "TIT2", text: "Yesterday" },
      { id: "TPE1", text: "The Beatles" },
    ]);
    const meta = await extractAudioMetadata(new Blob([buf]), "track.mp3");
    expect(meta.title).toBe("Yesterday");
    expect(meta.artist).toBe("The Beatles");
  });

  it("reads FLAC Vorbis comments", async () => {
    const buf = flacVorbisCommentBlock(["ARTIST=FLAC Artist", "TITLE=FLAC Song", "ALBUM=FLAC Album"]);
    const meta = await extractAudioMetadata(new Blob([buf]), "track.flac");
    expect(meta.title).toBe("FLAC Song");
    expect(meta.artist).toBe("FLAC Artist");
    expect(meta.album).toBe("FLAC Album");
  });

  it("reads ID3v1 tag at end of MP3", async () => {
    const audio = new Uint8Array(200);
    const tag = new Uint8Array(128);
    tag.set([0x54, 0x41, 0x47]); // TAG
    const enc = new TextEncoder();
    tag.set(enc.encode("End Title"), 3);
    tag.set(enc.encode("End Artist"), 33);
    tag.set(enc.encode("End Album"), 63);
    const combined = new Uint8Array(audio.length + tag.length);
    combined.set(audio, 0);
    combined.set(tag, audio.length);
    const tags = await extractAudioTagsDetailed(new Blob([combined]), "end-tags.mp3");
    expect(tags.artist).toBe("End Artist");
    expect(tags.title).toBe("End Title");
    expect(tags.tooltip).toContain("Artist: End Artist");
  });
});
