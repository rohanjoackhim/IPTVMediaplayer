import type { LyricsJsonFetcher } from "./lyricsJsonFetch";
import { libreTranslateSourceForFranc3 } from "./franc3ToLibreTranslateSource";
import { myMemorySourceForFranc3 } from "./franc3ToMyMemorySource";
import { myMemoryCodeForIso639_1 } from "./lyricsTargetLanguages";
import { parseGoogleGtxTranslate } from "./parseGoogleGtxTranslate";

export type LyricTranslationProvider = "lyrics_chat" | "google_gtx" | "libretranslate" | "mymemory";

export interface TranslateLyricsLinesResult {
  lines: string[];
  /** Short headline fragment, e.g. `Translation: LLM` or free-tier notice. */
  providerHint: string;
  /** True if any batch used the paid OpenAI-compatible lyrics LLM. */
  usedLlm: boolean;
}

function orderedUniqueProviders(list: LyricTranslationProvider[]): LyricTranslationProvider[] {
  const seen = new Set<LyricTranslationProvider>();
  const out: LyricTranslationProvider[] = [];
  for (const p of list) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Builds a single-line hint for lyrics headlines (paid vs free backends). */
export function lyricTranslationProviderHint(providers: LyricTranslationProvider[]): string {
  const u = orderedUniqueProviders(providers);
  if (!u.length) return "";

  const paidOrder: LyricTranslationProvider[] = ["lyrics_chat"];
  const name: Record<LyricTranslationProvider, string> = {
    lyrics_chat: "LLM (OpenAI-compatible)",
    google_gtx: "Google (public)",
    libretranslate: "LibreTranslate",
    mymemory: "MyMemory",
  };
  const paidPick = paidOrder.filter((p) => u.includes(p));
  if (paidPick.length) {
    const freeRest = u.filter((p) => !paidOrder.includes(p));
    let s = `Translation: ${paidPick.map((p) => name[p]).join(" + ")}`;
    if (freeRest.length) {
      s += ` (+ ${freeRest.map((p) => name[p]).join("/")} on some batches)`;
    }
    return s;
  }

  const labels = u.map((p) => name[p] ?? p);
  return `Translation: ${labels.join("/")} (free; may rate-limit) — add an LLM API key in Settings for stable paid translation`;
}

/** LibreTranslate public instances tolerate larger POST bodies; stay conservative for rate limits. */
const LIBRE_MAX_CHARS = 2200;
const LIBRE_MAX_LINES = 28;

/**
 * Google `translate_a/single?client=gtx` is GET-only; keep under this so encoded URLs stay safe.
 * Undocumented public endpoint — may rate-limit or change; LibreTranslate + MyMemory follow.
 */
const GOOGLE_GTX_MAX_CHARS = 700;

/** Chunk size for chat-completions lyric translation (token budget). */
const LYRICS_CHAT_MAX_CHARS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Exported for unit tests — rejects quota / warning payloads MyMemory sometimes returns with HTTP 200. */
export function parseMyMemoryTranslation(data: unknown): string {
  if (!data || typeof data !== "object") throw new Error("Bad translation response.");
  const o = data as Record<string, unknown>;
  const rd = o.responseData;
  if (!rd || typeof rd !== "object") throw new Error("Bad translation response.");
  const rdo = rd as Record<string, unknown>;
  if (typeof rdo.error === "string" && rdo.error.trim()) {
    throw new Error(rdo.error.trim().slice(0, 200));
  }
  const t = rdo.translatedText;
  if (typeof t !== "string") throw new Error("Missing translatedText.");
  const bad = t.toUpperCase();
  if (
    bad.includes("MYMEMORY WARNING") ||
    bad.includes("YOU USED ALL AVAILABLE FREE") ||
    bad.includes("INVALID CREDENTIALS") ||
    (bad.includes("QUOTA") && bad.includes("MYMEMORY"))
  ) {
    throw new Error(
      "MyMemory free quota exhausted. Add an LLM translation key in Settings, or try again later."
    );
  }
  return t;
}

function parseLibreResponse(data: unknown): string {
  if (!data || typeof data !== "object") throw new Error("Bad LibreTranslate response.");
  const t = (data as Record<string, unknown>).translatedText;
  if (typeof t !== "string") throw new Error("Missing translatedText.");
  return t;
}

/** Split translated blob back into lines; tolerates minor count mismatch. */
export function alignTranslatedLines(originalBatch: string[], translatedBlob: string): string[] {
  const parts = translatedBlob.split(/\r?\n/).map((s) => s.trimEnd());
  if (parts.length === originalBatch.length) return parts;
  if (parts.length === 1 && originalBatch.length > 1) {
    return originalBatch.map(() => parts[0] ?? "");
  }
  const out: string[] = [];
  for (let i = 0; i < originalBatch.length; i++) {
    out.push(parts[i] ?? parts[parts.length - 1] ?? "");
  }
  return out;
}

async function translateMyMemoryChunk(
  q: string,
  memSource: string,
  memTarget: string,
  fetchJson: LyricsJsonFetcher
): Promise<string> {
  const u = new URL("https://api.mymemory.translated.net/get");
  u.searchParams.set("q", q);
  u.searchParams.set("langpair", `${memSource}|${memTarget}`);
  const data = await fetchJson(u.toString());
  return parseMyMemoryTranslation(data);
}

/** MyMemory rejects `q` over ~500 chars; split on lines (and slice long lines) before joining results. */
async function translateMyMemoryBatchedString(
  q: string,
  memSource: string,
  memTarget: string,
  fetchJson: LyricsJsonFetcher
): Promise<string> {
  const lines = q.split("\n");
  const merged: string[] = [];
  let buf: string[] = [];
  let len = 0;
  const flushBuf = async () => {
    if (!buf.length) return;
    const blob = await translateMyMemoryChunk(buf.join("\n"), memSource, memTarget, fetchJson);
    merged.push(...alignTranslatedLines(buf, blob));
    buf = [];
    len = 0;
    await sleep(140);
  };
  for (const line of lines) {
    if (line.length > 450) {
      await flushBuf();
      let acc = "";
      for (let off = 0; off < line.length; off += 450) {
        acc += await translateMyMemoryChunk(line.slice(off, off + 450), memSource, memTarget, fetchJson);
        await sleep(140);
      }
      merged.push(acc);
      continue;
    }
    const add = line.length + (buf.length ? 1 : 0);
    if (buf.length && len + add > 450) await flushBuf();
    buf.push(line);
    len += add;
  }
  await flushBuf();
  return merged.join("\n");
}

const LIBRE_URLS = ["https://libretranslate.com/translate", "https://translate.argosopentech.com/translate"] as const;

function isNoLyricsChatTranslateKeyError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return m.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY");
}

interface LyricTranslateChunk {
  text: string;
  /** Appended after this chunk’s translation when another chunk follows. */
  glueAfterTranslation: string;
}

/** Split `q` for repeated cloud translate calls while preserving newlines between logical line groups. */
function chunkLyricTextForCloudTranslate(q: string, max: number): LyricTranslateChunk[] {
  const lines = q.split("\n");
  const chunks: LyricTranslateChunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  const flushBuf = (glueAfter: string): void => {
    if (!buf.length) return;
    chunks.push({ text: buf.join("\n"), glueAfterTranslation: glueAfter });
    buf = [];
    bufLen = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length > max) {
      flushBuf("\n");
      let o = 0;
      while (o < line.length) {
        const slice = line.slice(o, o + max);
        o += max;
        const isLastSlice = o >= line.length;
        const moreLinesAfter = i < lines.length - 1;
        const glue = isLastSlice ? (moreLinesAfter ? "\n" : "") : "";
        chunks.push({ text: slice, glueAfterTranslation: glue });
      }
      continue;
    }
    const add = line.length + (buf.length ? 1 : 0);
    if (buf.length && bufLen + add > max) {
      flushBuf("\n");
    }
    buf.push(line);
    bufLen += add;
  }
  flushBuf("");
  return chunks;
}

async function translateLyricsChatFull(
  q: string,
  libreSource: string,
  targetLang: string
): Promise<string | null> {
  const ipc = typeof window !== "undefined" ? window.iptv?.lyricsChatTranslate : undefined;
  if (typeof ipc !== "function") return null;
  const pieces = chunkLyricTextForCloudTranslate(q, LYRICS_CHAT_MAX_CHARS);
  let out = "";
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    let pieceOk = false;
    let pieceErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(600);
      try {
        const data = await ipc({
          q: piece.text,
          source: libreSource.trim().toLowerCase(),
          target: targetLang,
        });
        out += parseLibreResponse(data);
        pieceOk = true;
        break;
      } catch (e) {
        if (isNoLyricsChatTranslateKeyError(e)) return null;
        pieceErr = e;
      }
    }
    if (!pieceOk) throw pieceErr instanceof Error ? pieceErr : new Error(String(pieceErr));
    out += piece.glueAfterTranslation;
    if (i < pieces.length - 1) await sleep(120);
  }
  return out;
}

/** Chunked public GTX path (GET, ~700 chars per request) so long lyric batches avoid MyMemory when possible. */
async function translateGoogleGtxFull(
  q: string,
  sourceLang: string,
  targetLang: string
): Promise<string | null> {
  const pieces = chunkLyricTextForCloudTranslate(q, GOOGLE_GTX_MAX_CHARS);
  let out = "";
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    let pieceOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(220 * 2 ** (attempt - 1));
      try {
        out += await translateGoogleGtxOnce(piece.text, sourceLang, targetLang);
        pieceOk = true;
        break;
      } catch {
        /* try next attempt */
      }
    }
    if (!pieceOk) return null;
    out += piece.glueAfterTranslation;
    if (i < pieces.length - 1) await sleep(110);
  }
  return out;
}

async function translateGoogleGtxOnce(q: string, sourceLang: string, targetLang: string): Promise<string> {
  const sl = sourceLang.trim().toLowerCase();
  const tl = targetLang.trim().toLowerCase();
  const ipc = typeof window !== "undefined" ? window.iptv?.googleTranslateGtx : undefined;
  if (typeof ipc === "function") {
    const data = await ipc({ q, source: sl, target: tl });
    return parseLibreResponse(data);
  }
  const u = new URL("https://translate.googleapis.com/translate_a/single");
  u.searchParams.set("client", "gtx");
  u.searchParams.set("sl", sl);
  u.searchParams.set("tl", tl);
  u.searchParams.set("dt", "t");
  u.searchParams.set("q", q);
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; RJ-IPTV-and-Online-Radio-Player/1.0)",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Translate HTTP ${res.status}`);
  }
  const cleaned = text.replace(/^\)\]\}'\d*\n?/, "").trimStart();
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error("Google Translate returned non-JSON.");
  }
  return parseGoogleGtxTranslate(data);
}

async function translateLibreChunk(q: string, libreSource: string, targetLang: string): Promise<string> {
  const body = JSON.stringify({ q, source: libreSource, target: targetLang, format: "text" });
  const ipc = typeof window !== "undefined" ? window.iptv?.libreTranslate : undefined;
  if (typeof ipc === "function") {
    const data = await ipc({ q, source: libreSource, target: targetLang });
    return parseLibreResponse(data);
  }
  let last: unknown;
  for (const url of LIBRE_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const err =
          data && typeof data === "object" && typeof (data as Record<string, unknown>).error === "string"
            ? String((data as Record<string, unknown>).error)
            : `HTTP ${res.status}`;
        throw new Error(err.slice(0, 200));
      }
      return parseLibreResponse(data);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function translateBatchWithFallback(
  q: string,
  libreSource: string,
  memSource: string,
  memTarget: string,
  targetLang: string,
  fetchJson: LyricsJsonFetcher
): Promise<{ text: string; provider: LyricTranslationProvider }> {
  let lastErr: unknown;
  try {
    const viaChat = await translateLyricsChatFull(q, libreSource, targetLang);
    if (viaChat != null) return { text: viaChat, provider: "lyrics_chat" };
  } catch (e) {
    lastErr = e;
  }
  try {
    const viaGtx = await translateGoogleGtxFull(q, libreSource, targetLang);
    if (viaGtx != null) return { text: viaGtx, provider: "google_gtx" };
  } catch (e) {
    lastErr = e;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(380 * 2 ** (attempt - 1));
    try {
      const text = await translateLibreChunk(q, libreSource, targetLang);
      return { text, provider: "libretranslate" };
    } catch (e) {
      lastErr = e;
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const is429 =
      attempt > 0 &&
      lastErr != null &&
      /(^|\s)(429|HTTP\s*429)\b/i.test(lastErr instanceof Error ? lastErr.message : String(lastErr));
    if (attempt) await sleep(is429 ? 2800 + attempt * 900 : 650 + attempt * 850);
    try {
      if (q.length <= 450) {
        const text = await translateMyMemoryChunk(q, memSource, memTarget, fetchJson);
        return { text, provider: "mymemory" };
      }
      const text = await translateMyMemoryBatchedString(q, memSource, memTarget, fetchJson);
      return { text, provider: "mymemory" };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function translateLineBatchesCore(
  lines: string[],
  targetLang: string,
  libreSrc: string,
  memSrc: string,
  memTarget: string,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal
): Promise<TranslateLyricsLinesResult> {
  const out: string[] = [];
  const providersUsed: LyricTranslationProvider[] = [];
  let i = 0;
  while (i < lines.length) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const raw = lines[i] ?? "";

    const chunkLongLine = async (text: string, maxChars: number) => {
      const partsOut: string[] = [];
      for (let off = 0; off < text.length; off += maxChars) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const sub = text.slice(off, off + maxChars);
        const r = await translateBatchWithFallback(
          sub,
          libreSrc,
          memSrc,
          memTarget,
          targetLang,
          fetchJson
        );
        providersUsed.push(r.provider);
        partsOut.push(r.text);
        await sleep(95);
      }
      return partsOut.join("");
    };

    if (raw.length > LIBRE_MAX_CHARS) {
      out.push(await chunkLongLine(raw, LIBRE_MAX_CHARS));
      i++;
      await sleep(100);
      continue;
    }

    if (raw.length > 450 && raw.length <= LIBRE_MAX_CHARS) {
      const r = await translateBatchWithFallback(
        raw,
        libreSrc,
        memSrc,
        memTarget,
        targetLang,
        fetchJson
      );
      providersUsed.push(r.provider);
      out.push(r.text);
      i++;
      await sleep(100);
      continue;
    }

    const batch: string[] = [];
    let len = 0;
    const maxChars = LIBRE_MAX_CHARS;
    const maxLines = LIBRE_MAX_LINES;
    while (i < lines.length && batch.length < maxLines) {
      const line = lines[i] ?? "";
      if (line.length > maxChars) break;
      const add = line.length + (batch.length ? 1 : 0);
      if (batch.length && len + add > maxChars) break;
      batch.push(line);
      len += add;
      i++;
    }
    if (!batch.length) {
      const long = lines[i] ?? "";
      if (!long) {
        i++;
        continue;
      }
      if (long.length > LIBRE_MAX_CHARS) {
        out.push(await chunkLongLine(long, LIBRE_MAX_CHARS));
      } else {
        const r = await translateBatchWithFallback(
          long,
          libreSrc,
          memSrc,
          memTarget,
          targetLang,
          fetchJson
        );
        providersUsed.push(r.provider);
        out.push(r.text);
      }
      i++;
      await sleep(100);
      continue;
    }
    const q = batch.join("\n");
    const blob = await translateBatchWithFallback(
      q,
      libreSrc,
      memSrc,
      memTarget,
      targetLang,
      fetchJson
    );
    providersUsed.push(blob.provider);
    const aligned = alignTranslatedLines(batch, blob.text);
    for (let k = 0; k < batch.length; k++) {
      out.push(aligned[k] ?? "");
    }
    await sleep(105);
  }
  return {
    lines: out,
    providerHint: lyricTranslationProviderHint(providersUsed),
    usedLlm: providersUsed.includes("lyrics_chat"),
  };
}

function resolveLyricsTranslateSources(detectedFranc3: string): {
  libreSrc: string;
  memSrc: string;
} {
  const libreSrc = libreTranslateSourceForFranc3(detectedFranc3) ?? "auto";
  const memSrc = myMemorySourceForFranc3(detectedFranc3) ?? "en";
  return { libreSrc, memSrc };
}

/**
 * Translate lyric lines to English: optional **OpenAI-compatible chat API** (DeepSeek, OpenAI, OpenRouter, etc.);
 * otherwise public **Google GTX** (chunked), **LibreTranslate**, then **MyMemory**. Batches preserve newlines for line alignment.
 *
 * @param detectedFranc3 ISO 639-3 from franc (e.g. `spa`, `deu`)
 */
export async function translateLineBatchesToEnglish(
  lines: string[],
  detectedFranc3: string,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal
): Promise<TranslateLyricsLinesResult> {
  const memSrc = myMemorySourceForFranc3(detectedFranc3);
  const libreSrc = libreTranslateSourceForFranc3(detectedFranc3);
  if (!memSrc || !libreSrc) {
    throw new Error("No translation mapping for this language.");
  }
  return translateLineBatchesCore(
    lines,
    "en",
    libreSrc,
    memSrc,
    myMemoryCodeForIso639_1("en"),
    fetchJson,
    signal
  );
}

/**
 * Translate lyric lines to a target ISO 639-1 language (top languages menu in the lyrics panel).
 */
export async function translateLineBatchesToLanguage(
  lines: string[],
  targetLang: string,
  detectedFranc3: string,
  fetchJson: LyricsJsonFetcher,
  signal?: AbortSignal
): Promise<TranslateLyricsLinesResult> {
  const tl = targetLang.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(tl)) {
    throw new Error("Invalid target language.");
  }
  const { libreSrc, memSrc } = resolveLyricsTranslateSources(detectedFranc3);
  const memTarget = myMemoryCodeForIso639_1(tl);
  return translateLineBatchesCore(lines, tl, libreSrc, memSrc, memTarget, fetchJson, signal);
}

/**
 * Live radio captions: Google GTX only (skips LLM / Libre / MyMemory) for low latency.
 */
export async function translateLineBatchesToLanguageFast(
  lines: string[],
  targetLang: string,
  detectedFranc3: string,
  signal?: AbortSignal
): Promise<TranslateLyricsLinesResult> {
  const tl = targetLang.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(tl)) {
    throw new Error("Invalid target language.");
  }
  const { libreSrc } = resolveLyricsTranslateSources(detectedFranc3);
  const out: string[] = [];
  let batch: string[] = [];
  let batchLen = 0;

  const flushBatch = async () => {
    if (!batch.length) return;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const q = batch.join("\n");
    let translated: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(90);
      try {
        translated = await translateGoogleGtxFull(q, libreSrc, tl);
        if (translated != null) break;
      } catch {
        /* retry GTX */
      }
    }
    const aligned =
      translated != null ? alignTranslatedLines(batch, translated) : batch.map((l) => l.trim());
    for (let k = 0; k < batch.length; k++) out.push(aligned[k] ?? batch[k] ?? "");
    batch = [];
    batchLen = 0;
    await sleep(35);
  };

  for (const line of lines) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const raw = line ?? "";
    if (!raw.trim()) {
      await flushBatch();
      out.push("");
      continue;
    }
    const add = raw.length + (batch.length ? 1 : 0);
    if (batch.length && batchLen + add > GOOGLE_GTX_MAX_CHARS) await flushBatch();
    batch.push(raw);
    batchLen += add;
    if (batch.length >= 6) await flushBatch();
  }
  await flushBatch();

  return {
    lines: out,
    providerHint: "Live captions · Google (fast)",
    usedLlm: false,
  };
}
