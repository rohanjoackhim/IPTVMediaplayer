/**
 * RJ IPTV and Online Radio Player — Electron shell.
 * Serves the Vite `dist` folder over http://127.0.0.1 so playlist/stream fetches behave like a normal web origin
 * (avoids file:// + CORS issues). Uses a **stable port** when possible so `localStorage` (channels, favorites, settings)
 * stays on the same origin across restarts. Desktop targets: recent Windows (x64), macOS (arm64 / Intel per build).
 */
const { app, BrowserWindow, ipcMain, Menu, clipboard, session, net, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");

/** Load `.env` from several locations (dev, packaged, cwd) so `DEEPSEEK_API_KEY` / `GEMINI_*` are visible to IPC. */
function loadEnvFromProjectRoot() {
  try {
    const dotenv = require("dotenv");
    const candidates = [
      path.join(__dirname, "..", ".env"),
      path.join(process.cwd(), ".env"),
    ];
    if (app && typeof app.isPackaged === "boolean" && app.isPackaged) {
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, ".env"));
      }
      try {
        candidates.push(path.join(path.dirname(process.execPath), ".env"));
      } catch {
        /* noop */
      }
    }
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          dotenv.config({ path: p });
          return;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* dotenv is optional */
  }
}
loadEnvFromProjectRoot();
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { fileURLToPath, pathToFileURL } = require("url");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

/** All bound static servers (same handler); closed on window quit. */
let staticServers = [];
/** [primary, secondary] origins for /__proxy/stream — separate ports avoid browser per-host connection limits in split view. */
let streamProxyOriginsForIpc = null;

function assertPlaylistUrlForMain(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("Invalid playlist URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) playlist links are supported.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "169.254.169.254" || h === "metadata.google.internal") {
    throw new Error("That host is not allowed.");
  }
  return u.toString();
}

ipcMain.handle("iptv-fetch-playlist-text", async (_evt, rawUrl) => {
  const url = assertPlaylistUrlForMain(rawUrl);
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": "IPTV-Player/1.0 (Electron)" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
  }
  return res.text();
});

function assertYoutubeSearchQuery(raw) {
  const s = String(raw ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 180);
  if (!s) throw new Error("Empty search query.");
  return s;
}

function unescapeYoutubeTitleJsonFragment(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\u([0-9a-fA-F]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim()
    .slice(0, 280);
}

/** First organic result: video id + watch page title (for lyrics / display). */
function extractYoutubeFirstSearchResult(html) {
  const idx = html.indexOf('"videoRenderer":');
  if (idx === -1) return null;
  const slice = html.slice(idx, idx + 18_000);
  const vm = slice.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (!vm) return null;
  const tm = slice.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]{1,600})"/);
  const titleRaw = tm ? tm[1] : "";
  const title = titleRaw ? unescapeYoutubeTitleJsonFragment(titleRaw) : "";
  return { videoId: vm[1], title: title || null };
}

ipcMain.handle("iptv-youtube-first-video-id", async (_evt, rawQuery) => {
  const q = assertYoutubeSearchQuery(rawQuery);
  const u = new URL("https://www.youtube.com/results");
  u.searchParams.set("search_query", q);
  u.searchParams.set("hl", "en");
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`YouTube returned HTTP ${res.status}.`);
  }
  const html = await res.text();
  if (!html.includes("videoRenderer")) {
    throw new Error(
      "Could not read YouTube search results (consent or network page). Try again in a moment or search on youtube.com manually."
    );
  }
  const meta = extractYoutubeFirstSearchResult(html);
  if (!meta?.videoId) {
    throw new Error("No video results found for that search.");
  }
  return { videoId: meta.videoId, title: meta.title };
});

function assertLyricsHttpGetUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Invalid URL.");
  }
  if (u.protocol !== "https:") throw new Error("Only https URLs are allowed.");
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === "lrclib.net" && path.startsWith("/api/")) return u.toString();
  if (host === "api.mymemory.translated.net" && path === "/get") return u.toString();
  throw new Error("URL host is not allowed for lyrics fetch.");
}

const MAX_ALBUM_ART_BYTES = 512 * 1024;

function normalizeItunesArtworkUrl(urlRaw) {
  const u = String(urlRaw ?? "").trim();
  if (!u.startsWith("https://")) return "";
  return u.replace(/100x100bb/g, "600x600bb").replace(/100x100/g, "600x600");
}

function scoreItunesHit(hit, artist, title) {
  if (!hit || typeof hit !== "object") return -1;
  const wantA = String(artist ?? "")
    .trim()
    .toLowerCase();
  const wantT = String(title ?? "")
    .trim()
    .toLowerCase();
  const a = String(hit.artistName ?? "")
    .toLowerCase();
  const t = String(hit.trackName ?? "")
    .toLowerCase();
  const coll = String(hit.collectionName ?? "")
    .toLowerCase();
  let score = 0;
  if (hit.artworkUrl100 || hit.artworkUrl60) score += 2;
  if (wantT && t === wantT) score += 12;
  else if (wantT && t.includes(wantT)) score += 8;
  if (wantA && a === wantA) score += 12;
  else if (wantA && a.includes(wantA)) score += 7;
  if (wantT && coll.includes(wantT)) score += 3;
  return score;
}

function pickItunesArtworkUrl(results, artist, title) {
  if (!Array.isArray(results) || !results.length) return "";
  let best = "";
  let bestScore = -1;
  for (const hit of results) {
    const score = scoreItunesHit(hit, artist, title);
    const url = normalizeItunesArtworkUrl(hit.artworkUrl100 || hit.artworkUrl60 || "");
    if (!url) continue;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

async function itunesSearchArtworkUrl(artist, title, album, entity) {
  const parts = [artist, title, album].map((s) => String(s ?? "").trim()).filter(Boolean);
  const term = parts.join(" ").slice(0, 180);
  if (term.length < 2) return "";
  const u = new URL("https://itunes.apple.com/search");
  u.searchParams.set("term", term);
  u.searchParams.set("entity", entity);
  u.searchParams.set("limit", "8");
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return "";
  const data = await res.json();
  const results = data && typeof data === "object" ? data.results : null;
  return pickItunesArtworkUrl(results, artist, title);
}

function assertMzstaticImageUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Invalid artwork URL.");
  }
  if (u.protocol !== "https:") throw new Error("Artwork URL must be https.");
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".mzstatic.com")) throw new Error("Artwork host not allowed.");
  return u.toString();
}

ipcMain.handle("iptv-fetch-album-art-online", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const artist = typeof p.artist === "string" ? p.artist.trim().slice(0, 200) : "";
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  const album = typeof p.album === "string" ? p.album.trim().slice(0, 200) : "";
  if (!artist && !title && !album) {
    return { ok: false, error: "No artist or title for artwork lookup." };
  }
  try {
    let artUrl = await itunesSearchArtworkUrl(artist, title, album, "song");
    if (!artUrl) {
      artUrl = await itunesSearchArtworkUrl(artist, title, album, "album");
    }
    if (!artUrl) {
      return { ok: false, error: "No artwork found on iTunes." };
    }
    const safeUrl = assertMzstaticImageUrl(artUrl);
    const imgRes = await fetch(safeUrl, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "image/*", "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!imgRes.ok) {
      return { ok: false, error: `Artwork download HTTP ${imgRes.status}` };
    }
    const buf = await imgRes.arrayBuffer();
    if (!buf || buf.byteLength < 32) {
      return { ok: false, error: "Artwork file was empty." };
    }
    const trimmed = buf.byteLength > MAX_ALBUM_ART_BYTES ? buf.slice(0, MAX_ALBUM_ART_BYTES) : buf;
    const mimeRaw = imgRes.headers.get("content-type") || "image/jpeg";
    const mime = mimeRaw.split(";")[0].trim().toLowerCase() || "image/jpeg";
    return { ok: true, mime, data: trimmed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200) };
  }
});

ipcMain.handle("iptv-http-get-json", async (_evt, rawUrl) => {
  const url = assertLyricsHttpGetUrl(rawUrl);
  let parsedHost = "";
  try {
    parsedHost = new URL(url).hostname.toLowerCase();
  } catch {
    /* assertLyricsHttpGetUrl already validated */
  }
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    signal: AbortSignal.timeout(35_000),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 429 && parsedHost === "api.mymemory.translated.net") {
      throw new Error(
        "MyMemory free quota exceeded (HTTP 429). Add Google Cloud or Azure Translator in app settings, wait, or try again later."
      );
    }
    throw new Error(text ? `HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}` : `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Lyrics service returned non-JSON.");
  }
});

async function postLibreTranslateToUrl(urlStr, bodyObj) {
  const res = await fetch(urlStr, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LibreTranslate returned non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const err =
      typeof data === "object" && data && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(String(err).slice(0, 200));
  }
  if (typeof data.translatedText !== "string") {
    throw new Error("LibreTranslate response missing translatedText.");
  }
  return data.translatedText;
}

/** Same parsing as `src/utils/parseGoogleGtxTranslate.ts` (kept inline: main is CommonJS). */
function parseGoogleGtxTranslateMain(data) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Bad Google Translate response.");
  }
  const head = data[0];
  if (!Array.isArray(head)) {
    throw new Error("Bad Google Translate response.");
  }
  let out = "";
  for (const item of head) {
    if (Array.isArray(item) && typeof item[0] === "string") {
      out += item[0];
    }
  }
  if (!out) {
    throw new Error("Google Translate response had no text.");
  }
  return out;
}

function normalizeTranslateLangCode(raw, fallback = "en") {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(t)) return fallback;
  return t;
}

async function fetchGoogleGtxTranslated(q, sl, tl = "en") {
  const u = new URL("https://translate.googleapis.com/translate_a/single");
  u.searchParams.set("client", "gtx");
  u.searchParams.set("sl", normalizeTranslateLangCode(sl, "auto"));
  u.searchParams.set("tl", normalizeTranslateLangCode(tl, "en"));
  u.searchParams.set("dt", "t");
  u.searchParams.set("q", q);
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Translate HTTP ${res.status}`);
  }
  const cleaned = text.replace(/^\)\]\}'\d*\n?/, "").trimStart();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error("Google Translate returned non-JSON.");
  }
  return parseGoogleGtxTranslateMain(data);
}

const LYRICS_CHAT_KEY_PATH = () => path.join(app.getPath("userData"), "lyrics-chat-translate-api-key.txt");
const LYRICS_CHAT_BASE_URL_PATH = () => path.join(app.getPath("userData"), "lyrics-chat-translate-base-url.txt");
const LYRICS_CHAT_MODEL_PATH = () => path.join(app.getPath("userData"), "lyrics-chat-translate-model.txt");

function getLyricsChatTranslateApiKey() {
  // Priority: `.env` / shell env (see dotenv at top of this file) → saved Settings file.
  const fromEnv = String(
    process.env.DEEPSEEK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.OPENAI_COMPATIBLE_LYRICS_API_KEY ??
      ""
  ).trim();
  if (fromEnv) return fromEnv;
  try {
    const p = LYRICS_CHAT_KEY_PATH();
    if (fs.existsSync(p)) {
      const t = String(fs.readFileSync(p, "utf8") ?? "").trim();
      if (t) return t;
    }
  } catch {
    /* noop */
  }
  return "";
}

function getLyricsChatTranslateBaseUrlRaw() {
  const fromEnv = String(process.env.OPENAI_COMPATIBLE_LYRICS_BASE_URL ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const p = LYRICS_CHAT_BASE_URL_PATH();
    if (fs.existsSync(p)) {
      const t = String(fs.readFileSync(p, "utf8") ?? "").trim();
      if (t) return t;
    }
  } catch {
    /* noop */
  }
  return "";
}

function getLyricsChatTranslateModelRaw() {
  const fromEnv = String(process.env.OPENAI_COMPATIBLE_LYRICS_MODEL ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const p = LYRICS_CHAT_MODEL_PATH();
    if (fs.existsSync(p)) {
      const t = String(fs.readFileSync(p, "utf8") ?? "").trim();
      if (t) return t;
    }
  } catch {
    /* noop */
  }
  return "";
}

function assertLyricsChatApiKeyInput(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return "";
  if (t.length < 8 || t.length > 512 || /[\s\x00-\x1f]/.test(t)) {
    throw new Error("API key looks invalid (length or characters).");
  }
  return t;
}

function assertLyricsChatBaseUrlInput(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return "";
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error("Base URL is not a valid URL.");
  }
  if (u.protocol !== "https:") {
    throw new Error("Base URL must use https.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") {
    throw new Error("Base URL host is not allowed.");
  }
  return u.toString().replace(/\/+$/, "");
}

function assertLyricsChatModelInput(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return "";
  if (t.length > 80 || !/^[a-zA-Z0-9._-]+$/.test(t)) {
    throw new Error("Model id looks invalid.");
  }
  return t;
}

/** Build `…/v1/chat/completions` from API root (DeepSeek, OpenAI, OpenRouter, etc.). */
function lyricsChatCompletionsEndpoint(baseRaw) {
  const defaultBase = "https://api.deepseek.com";
  const raw = String(baseRaw ?? "").trim() || defaultBase;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid base URL.");
  }
  if (u.protocol !== "https:") {
    throw new Error("Base URL must be https.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") {
    throw new Error("Base URL host is not allowed.");
  }
  let path = u.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    return `${u.origin}${path}`;
  }
  if (!path) {
    return `${u.origin}/v1/chat/completions`;
  }
  if (path.endsWith("/v1")) {
    return `${u.origin}${path}/chat/completions`;
  }
  return `${u.origin}${path}/v1/chat/completions`;
}

function stripLlmMarkdownFences(text) {
  let t = String(text ?? "").trim();
  if (!t) return t;
  const block = /^```(?:[a-zA-Z0-9_-]*)?\r?\n([\s\S]*?)\r?\n```\s*$/;
  const m = t.match(block);
  if (m) return m[1].trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, "").replace(/\r?\n?```\s*$/u, "").trim();
  }
  return t;
}

function getLyricsLlmConfig() {
  const model = getLyricsChatTranslateModelRaw() || "deepseek-chat";
  let host = "api.deepseek.com";
  try {
    host = new URL(getLyricsChatTranslateBaseUrlRaw() || "https://api.deepseek.com").hostname;
  } catch {
    /* keep default */
  }
  return { model, host };
}

/** Human-readable error: which feature failed and which model/host was used. */
function formatLyricsLlmError(purpose, message) {
  const { model, host } = getLyricsLlmConfig();
  const clean = String(message ?? "")
    .replace(/^LLM(\s*\([^)]*\))?:\s*/i, "")
    .replace(/\s*\[model:[^\]]+\]\s*$/i, "")
    .trim();
  return `LLM (${purpose}): ${clean || "request failed"} [model: ${model} @ ${host}]`;
}

function lyricsLlmMetaFields(purpose) {
  const { model, host } = getLyricsLlmConfig();
  return { llmModel: model, llmHost: host, llmPurpose: purpose };
}

async function postLyricsLlmChatCompletion(bodyObj, purpose = "LLM request") {
  const apiKey = getLyricsChatTranslateApiKey();
  if (!apiKey) {
    throw new Error("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY");
  }
  const { model: defaultModel } = getLyricsLlmConfig();
  const baseRaw = getLyricsChatTranslateBaseUrlRaw();
  const endpoint = lyricsChatCompletionsEndpoint(baseRaw || "https://api.deepseek.com");
  const body = JSON.stringify({
    ...bodyObj,
    model: typeof bodyObj.model === "string" && bodyObj.model.trim() ? bodyObj.model.trim() : defaultModel,
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`LLM: non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && data.error && typeof data.error.message === "string"
        ? data.error.message
        : bodyText.slice(0, 280).replace(/\s+/g, " ");
    throw new Error(formatLyricsLlmError(purpose, msg));
  }
  const choice = data && typeof data === "object" ? data.choices : null;
  const first = Array.isArray(choice) && choice.length ? choice[0] : null;
  const msgObj = first && typeof first === "object" ? first.message : null;
  const content =
    msgObj && typeof msgObj === "object" && typeof msgObj.content === "string" ? msgObj.content : null;
  if (!content || !String(content).trim()) {
    throw new Error("LLM: empty content.");
  }
  return stripLlmMarkdownFences(content);
}

function parseLlmUnifiedLyricsJsonText(text, displayName) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    const j = text.lastIndexOf("}");
    if (i < 0 || j <= i) {
      throw new Error("LLM unified: response was not valid JSON.");
    }
    obj = JSON.parse(text.slice(i, j + 1));
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "Bad JSON root", pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  if (obj.ok !== true) {
    const msg = typeof obj.message === "string" ? obj.message.trim().slice(0, 220) : "No lyrics from model.";
    return { ok: false, error: msg, pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  const pairsIn = obj.pairs;
  if (!Array.isArray(pairsIn) || pairsIn.length === 0) {
    return { ok: false, error: "Model returned no lyric lines.", pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  const pairs = [];
  const maxLines = 120;
  for (let i = 0; i < Math.min(pairsIn.length, maxLines); i++) {
    const row = pairsIn[i];
    if (!row || typeof row !== "object") continue;
    const orig = typeof row.orig === "string" ? row.orig.replace(/\r\n/g, "\n").trimEnd() : "";
    let en = typeof row.en === "string" ? row.en.replace(/\r\n/g, "\n").trimEnd() : "";
    if (!orig) continue;
    if (!en) en = orig;
    pairs.push({ orig, en });
  }
  if (!pairs.length) {
    return { ok: false, error: "No valid orig/en pairs.", pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  let detected = typeof obj.detectedFranc3 === "string" ? obj.detectedFranc3.trim().toLowerCase() : "und";
  if (!/^[a-z]{3}$/.test(detected)) detected = "und";
  const lrclibTrack =
    typeof obj.lrclibTrack === "string" && obj.lrclibTrack.trim()
      ? obj.lrclibTrack.trim().slice(0, 240)
      : String(displayName ?? "").trim().slice(0, 240) || "LLM";
  const headlineBase =
    typeof obj.headline === "string" && obj.headline.trim()
      ? obj.headline.trim().slice(0, 200)
      : lrclibTrack;
  const headline = `LLM: ${headlineBase} · find + translate in one step (verify; may differ from official lyrics)`;
  return { ok: true, error: "", pairs, detectedFranc3: detected, headline, lrclibTrack };
}

ipcMain.handle("iptv-lyrics-chat-translate-key-status", async () => {
  const hasKey = !!getLyricsChatTranslateApiKey();
  const geminiFromEnv = !!getGeminiApiKeyFromEnv();
  const hasSongMeaningKey = hasKey || geminiFromEnv;
  const base = getLyricsChatTranslateBaseUrlRaw();
  const model = getLyricsChatTranslateModelRaw();
  let apiBasePreview = "";
  try {
    if (base) {
      const u = new URL(base);
      apiBasePreview = u.host;
    } else {
      apiBasePreview = "api.deepseek.com (default)";
    }
  } catch {
    apiBasePreview = "(invalid saved URL)";
  }
  return {
    hasKey,
    hasSongMeaningKey,
    hasGeminiFromEnv: geminiFromEnv,
    apiBasePreview,
    modelPreview: model || "deepseek-chat (default)",
  };
});

ipcMain.handle("iptv-lyrics-chat-translate-save-credentials", async (_evt, raw) => {
  const p = raw && typeof raw === "object" ? raw : {};
  const key = assertLyricsChatApiKeyInput(typeof p.key === "string" ? p.key : "");
  const baseUrl = assertLyricsChatBaseUrlInput(typeof p.baseUrl === "string" ? p.baseUrl : "");
  const model = assertLyricsChatModelInput(typeof p.model === "string" ? p.model : "");
  const keyPath = LYRICS_CHAT_KEY_PATH();
  const basePath = LYRICS_CHAT_BASE_URL_PATH();
  const modelPath = LYRICS_CHAT_MODEL_PATH();
  if (!key) {
    try {
      fs.unlinkSync(keyPath);
    } catch {
      /* missing */
    }
    try {
      fs.unlinkSync(basePath);
    } catch {
      /* missing */
    }
    try {
      fs.unlinkSync(modelPath);
    } catch {
      /* missing */
    }
    return { ok: true, hasKey: false, apiBasePreview: "", modelPreview: "" };
  }
  fs.writeFileSync(keyPath, key, "utf8");
  if (baseUrl) {
    fs.writeFileSync(basePath, baseUrl, "utf8");
  } else {
    try {
      fs.unlinkSync(basePath);
    } catch {
      /* missing */
    }
  }
  if (model) {
    fs.writeFileSync(modelPath, model, "utf8");
  } else {
    try {
      fs.unlinkSync(modelPath);
    } catch {
      /* missing */
    }
  }
  const hasKey = true;
  let apiBasePreview = "";
  try {
    const u = new URL(baseUrl || "https://api.deepseek.com");
    apiBasePreview = u.host;
  } catch {
    apiBasePreview = "";
  }
  return {
    ok: true,
    hasKey,
    apiBasePreview,
    modelPreview: model || "deepseek-chat (default)",
  };
});

/**
 * OpenAI-compatible `POST /v1/chat/completions` (DeepSeek, OpenAI, OpenRouter, etc.).
 * Key: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `OPENAI_COMPATIBLE_LYRICS_API_KEY`, or saved file.
 */
ipcMain.handle("iptv-lyrics-llm-unified-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const displayName = typeof p.displayName === "string" ? p.displayName.trim() : "";
  if (!displayName || displayName.length > 400) {
    throw new Error("Invalid display name for LLM lyrics.");
  }
  const durationSec =
    typeof p.durationSec === "number" && Number.isFinite(p.durationSec) && p.durationSec >= 0
      ? Math.floor(p.durationSec)
      : null;
  const metaArtist = typeof p.metaArtist === "string" ? p.metaArtist.trim().slice(0, 200) : "";
  const metaTitle = typeof p.metaTitle === "string" ? p.metaTitle.trim().slice(0, 200) : "";
  const metaAlbum = typeof p.metaAlbum === "string" ? p.metaAlbum.trim().slice(0, 200) : "";

  const system = [
    "You help a music player show bilingual song lyrics.",
    "You must respond with ONLY a single JSON object (no markdown fences, no commentary before or after).",
    'Shape A success: {"ok":true,"detectedFranc3":"spa","lrclibTrack":"Artist — Title","headline":"short label","pairs":[{"orig":"line in original language","en":"English line"},...]}',
    'Shape B failure: {"ok":false,"message":"one short reason","pairs":[]}',
    "detectedFranc3 must be ISO 639-3 (three lowercase letters) when you can infer language, else use \"und\".",
    "pairs: each object needs \"orig\" and \"en\" strings; same number of logical lines; no empty orig.",
    "If you are not confident you have the correct official lyrics, set ok:false.",
    "Do not exceed 120 pairs. No LRC timestamps in strings.",
  ].join(" ");

  const user = [
    `Library display name: ${displayName}`,
    `Artist from file tags (ID3 / FLAC Vorbis / MP4): ${metaArtist || "unknown"}`,
    `Title from file tags: ${metaTitle || "unknown"}`,
    metaAlbum ? `Album from file tags: ${metaAlbum}` : "",
    `Approximate duration (seconds): ${durationSec != null ? String(durationSec) : "unknown"}`,
    "",
    "Use ONLY the tagged artist and title above to identify the song (do not invent a different artist or track from the filename alone).",
    "Find the best-matching official lyrics, then supply each line in the original language with an accurate English translation in the same array position.",
  ]
    .filter(Boolean)
    .join("\n");

  const llmPurpose = "lyrics find + translate";
  try {
    const rawText = await postLyricsLlmChatCompletion(
      {
        model: undefined,
        temperature: 0.2,
        max_tokens: 8192,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      llmPurpose
    );
    const parsed = parseLlmUnifiedLyricsJsonText(rawText, displayName);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.pairs) || !parsed.pairs.length) {
      return { ...parsed, ...lyricsLlmMetaFields(llmPurpose) };
    }
    return { ...parsed, ...lyricsLlmMetaFields(llmPurpose) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) throw e;
    return {
      ok: false,
      error: msg.includes("[model:") ? msg : formatLyricsLlmError(llmPurpose, msg),
      pairs: [],
      detectedFranc3: "und",
      headline: "",
      lrclibTrack: "",
      ...lyricsLlmMetaFields(llmPurpose),
    };
  }
});

/** Google Gemini (Google AI / AI Studio API key): used for song-meaning when `GEMINI_API_KEY` etc. are set. */
function getGeminiApiKeyFromEnv() {
  return String(
    process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_AI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      ""
  ).trim();
}

function getGeminiModelRaw() {
  const m = String(process.env.GEMINI_MODEL ?? process.env.GOOGLE_AI_MODEL ?? "").trim();
  const core = (m || "gemini-2.5-flash").replace(/^models\//, "");
  if (core.length > 96 || !/^[a-zA-Z0-9._-]+$/.test(core)) {
    throw new Error("Invalid GEMINI_MODEL / GOOGLE_AI_MODEL.");
  }
  return core;
}

/**
 * @returns `{ text }` — throws on HTTP / empty model output
 */
async function postGeminiGenerateSongMeaning(systemPrompt, userPrompt) {
  const apiKey = getGeminiApiKeyFromEnv();
  if (!apiKey) {
    throw new Error("IPTV_GEMINI_NO_KEY");
  }
  const modelId = getGeminiModelRaw();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelId
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 1024,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Gemini: non-JSON (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const gm =
      data && typeof data === "object" && data.error && typeof data.error.message === "string"
        ? data.error.message
        : bodyText.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`Gemini (song meaning): ${gm || `HTTP ${res.status}`} [model: ${modelId} @ generativelanguage.googleapis.com]`);
  }

  const cand = Array.isArray(data?.candidates) && data.candidates.length ? data.candidates[0] : null;
  const parts =
    cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const texts = [];
  for (const part of parts) {
    if (part && typeof part.text === "string" && part.text.trim()) texts.push(part.text);
  }
  const combined = texts.join("\n").trim();
  if (!combined) {
    throw new Error(
      `Gemini (song meaning): empty or blocked response [model: ${modelId} @ generativelanguage.googleapis.com]`
    );
  }
  return stripLlmMarkdownFences(combined);
}

ipcMain.handle("iptv-lyrics-song-meaning-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const artist = typeof p.artist === "string" ? p.artist.trim().slice(0, 200) : "";
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  const album = typeof p.album === "string" ? p.album.trim().slice(0, 200) : "";
  const displayName = typeof p.displayName === "string" ? p.displayName.trim().slice(0, 400) : "";
  if (!title && !artist && !displayName) {
    return { ok: false, meaning: "", error: "No song title or artist to look up." };
  }
  const songLabel =
    artist && title
      ? `${artist} — ${title}`
      : title || artist || displayName;
  const albumLine = album ? `Album: ${album}` : "";

  const system = [
    "You explain what songs mean for listeners who just read the lyrics.",
    "Write in clear English: 2–4 short paragraphs.",
    "Cover themes, story, mood, and what the songwriter is expressing.",
    "If you are not confident this is the correct recording, say so briefly and still give your best interpretation.",
    "Do not quote or invent full lyrics. No markdown headings or bullet lists.",
  ].join(" ");

  const user = [
    `Song: ${songLabel}`,
    albumLine,
    displayName && displayName !== songLabel ? `File / library name: ${displayName}` : "",
    "",
    "What is this song about?",
  ]
    .filter(Boolean)
    .join("\n");

  const geminiPurpose = "song meaning (Google Gemini)";
  const geminiKey = getGeminiApiKeyFromEnv();
  if (geminiKey) {
    try {
      let modelHost = "";
      try {
        modelHost = getGeminiModelRaw();
      } catch (eGemModel) {
        return {
          ok: false,
          meaning: "",
          error: eGemModel instanceof Error ? eGemModel.message.slice(0, 400) : String(eGemModel),
          llmPurpose: geminiPurpose,
          llmModel: "(invalid model)",
          llmHost: "generativelanguage.googleapis.com",
        };
      }

      const meaning = await postGeminiGenerateSongMeaning(system, user);
      const trimmed = String(meaning ?? "").trim();
      if (!trimmed) {
        return {
          ok: false,
          meaning: "",
          error: `${geminiPurpose}: empty response [model: ${modelHost} @ generativelanguage.googleapis.com]`,
          llmPurpose: geminiPurpose,
          llmModel: modelHost,
          llmHost: "generativelanguage.googleapis.com",
        };
      }
      return {
        ok: true,
        meaning: trimmed.slice(0, 6000),
        llmPurpose: geminiPurpose,
        llmModel: modelHost,
        llmHost: "generativelanguage.googleapis.com",
      };
    } catch (eGem) {
      const msgGem = eGem instanceof Error ? eGem.message : String(eGem);
      const hasOpenAiCompatible = !!getLyricsChatTranslateApiKey();
      if (!hasOpenAiCompatible) {
        return {
          ok: false,
          meaning: "",
          error: msgGem.slice(0, 440),
          llmPurpose: geminiPurpose,
          llmModel: (() => {
            try {
              return getGeminiModelRaw();
            } catch {
              return "?";
            }
          })(),
          llmHost: "generativelanguage.googleapis.com",
        };
      }
      /* Fallback: Gemini failed but OpenAI-compatible key exists */
    }
  }

  const llmPurpose = "song meaning";
  try {
    const meaning = await postLyricsLlmChatCompletion(
      {
        temperature: 0.35,
        max_tokens: 900,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      llmPurpose
    );
    const trimmed = String(meaning ?? "").trim();
    if (!trimmed) {
      return {
        ok: false,
        meaning: "",
        error: formatLyricsLlmError(llmPurpose, "empty response"),
        ...lyricsLlmMetaFields(llmPurpose),
      };
    }
    return { ok: true, meaning: trimmed.slice(0, 6000), ...lyricsLlmMetaFields(llmPurpose) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) {
      return {
        ok: false,
        meaning: "",
        error: geminiKey
          ? "Gemini song meaning failed; add DeepSeek/OpenAI-compatible key under Audio → Lyrics translation, or fix Gemini API/key."
          : "Add GEMINI_API_KEY (Google AI Studio) for song meaning here, or an LLM key under Audio → Lyrics translation.",
        ...lyricsLlmMetaFields(llmPurpose),
      };
    }
    return {
      ok: false,
      meaning: "",
      error: (msg.includes("[model:") ? msg : formatLyricsLlmError(llmPurpose, msg)).slice(0, 400),
      ...lyricsLlmMetaFields(llmPurpose),
    };
  }
});

const LYRICS_TARGET_LANG_NAMES = {
  en: "English",
  zh: "Chinese (Simplified)",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  ar: "Arabic",
  bn: "Bengali",
  pt: "Portuguese",
  ru: "Russian",
  ur: "Urdu",
  id: "Indonesian",
  de: "German",
  ja: "Japanese",
  tr: "Turkish",
  ko: "Korean",
  vi: "Vietnamese",
  it: "Italian",
  pl: "Polish",
  nl: "Dutch",
  th: "Thai",
};

ipcMain.handle("iptv-lyrics-chat-translate", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const q = typeof p.q === "string" ? p.q : "";
  const source = typeof p.source === "string" ? p.source.trim().toLowerCase() : "";
  const target = normalizeTranslateLangCode(p.target, "en");
  if (!q || q.length > 12_000) {
    throw new Error("Invalid translation text.");
  }
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(source)) {
    throw new Error("Invalid translation source language.");
  }
  const modelRaw = getLyricsChatTranslateModelRaw();
  const model = modelRaw || "deepseek-chat";
  const targetName = LYRICS_TARGET_LANG_NAMES[target] ?? target;
  const system = [
    `You translate song lyrics into ${targetName} (ISO 639-1: ${target}).`,
    "Preserve line breaks and the exact line count: do not merge lines, do not add blank lines, do not add headings or quotes.",
    "Output only the translated lyrics, no preamble or explanation.",
  ].join(" ");
  const user = `Source language (ISO 639-1): ${source}\nTarget language (ISO 639-1): ${target}\n\nLyrics:\n${q}`;
  const maxTokens = Math.min(8192, Math.max(512, Math.ceil(q.length * 0.45) + 400));
  const translatedText = await postLyricsLlmChatCompletion(
    {
      model,
      temperature: 0.15,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    "lyrics line translation"
  );
  const meta = lyricsLlmMetaFields("lyrics line translation");
  return { translatedText, ...meta };
});

/**
 * Google Translate web-style GET (`client=gtx`) for lyric batches under ~700 chars in the renderer.
 * Unofficial; may change. Renderer falls back to LibreTranslate + MyMemory.
 */
ipcMain.handle("iptv-google-translate-gtx", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const q = typeof p.q === "string" ? p.q : "";
  const source = typeof p.source === "string" ? p.source.trim().toLowerCase() : "";
  const target = normalizeTranslateLangCode(p.target, "en");
  if (!q || q.length > 1_200) {
    throw new Error("Invalid translation text.");
  }
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(source)) {
    throw new Error("Invalid translation source language.");
  }
  const translatedText = await fetchGoogleGtxTranslated(q, source, target);
  return { translatedText };
});

/**
 * LibreTranslate POST (public instances). Used for lyric line batches; falls back to MyMemory in the renderer if needed.
 */
ipcMain.handle("iptv-libre-translate", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const q = typeof p.q === "string" ? p.q : "";
  const source = typeof p.source === "string" ? p.source.trim().toLowerCase() : "";
  const target = normalizeTranslateLangCode(p.target, "en");
  if (!q || q.length > 12_000) {
    throw new Error("Invalid translation text.");
  }
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(source)) {
    throw new Error("Invalid translation source language.");
  }
  const body = { q, source, target, format: "text" };
  const urls = ["https://libretranslate.com/translate", "https://translate.argosopentech.com/translate"];
  let lastErr;
  for (const url of urls) {
    try {
      const translatedText = await postLibreTranslateToUrl(url, body);
      return { translatedText };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
});

const streamRecordings = new Map();

/** Set when the static server starts; used for same-origin tap URLs in IPC. */
let rendererOrigin = null;

function streamRecordHeaders(targetUrl) {
  const u = new URL(targetUrl);
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    Referer: `${u.origin}/`,
  };
}

function isLikelyHlsRecordUrl(url) {
  return /\.m3u8($|\?)/i.test(String(url));
}

const ALLOW_RECORD_TAP_TYPES = new Set([
  "video/mp2t",
  "audio/mpeg",
  "audio/aac",
  "audio/ogg",
  "application/octet-stream",
]);

function normalizeRecordTapMime(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return ALLOW_RECORD_TAP_TYPES.has(s) ? s : "video/mp2t";
}

function normalizeRecordFilenameExt(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (/^\.(mpeg|mp3|aac|ogg|opus|bin)$/.test(s)) return s;
  return ".mpeg";
}

ipcMain.handle("iptv-get-stream-proxy-origins", () => streamProxyOriginsForIpc ?? []);

ipcMain.handle("iptv-pick-record-dir", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "RJ IPTV and Online Radio Player — folder for recordings",
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  return r.filePaths[0];
});

function mimeForLocalAudioExt(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".mp3" || e === ".mpga" || e === ".mpeg") return "audio/mpeg";
  if (e === ".m4a" || e === ".m4b") return "audio/mp4";
  if (e === ".aac") return "audio/aac";
  if (e === ".ogg" || e === ".oga") return "audio/ogg";
  if (e === ".opus") return "audio/ogg";
  if (e === ".wav") return "audio/wav";
  if (e === ".flac") return "audio/flac";
  if (e === ".webm") return "audio/webm";
  return "";
}

/**
 * Native file picker + readFile in main (reliable on Windows vs renderer File / IndexedDB quirks).
 * Returns serializable rows for the renderer IndexedDB library.
 */
ipcMain.handle("iptv-pick-local-audio-files", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Audio",
        extensions: ["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wav", "flac", "webm", "mpga", "mpeg"],
      },
      { name: "All files", extensions: ["*"] },
    ],
    title: "RJ IPTV — add MP3 or audiobook files",
  });
  if (r.canceled || !r.filePaths?.length) return [];
  const out = [];
  const fsp = fs.promises;
  for (const fp of r.filePaths) {
    let stat;
    try {
      stat = await fsp.stat(fp);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const ext = path.extname(fp);
    const mime = mimeForLocalAudioExt(ext) || "application/octet-stream";
    const base = path.basename(fp);
    const name = ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base;
    const buf = await fsp.readFile(fp);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    out.push({
      fileName: base,
      name,
      size: stat.size,
      lastModified: stat.mtimeMs,
      addedAt: Date.now(),
      mime,
      data: ab,
    });
  }
  return out;
});

/**
 * Desktop: pick video files and return `file://` URLs for native `<video>` playback (no full-file read).
 */
function mimeForLocalVideoExt(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".avi" || e === ".divx") return "video/x-msvideo";
  if (e === ".mkv") return "video/x-matroska";
  if (e === ".mpeg" || e === ".mpg" || e === ".mpe" || e === ".mpv" || e === ".m1v" || e === ".m2v") return "video/mpeg";
  if (e === ".m2ts" || e === ".mts" || e === ".ts") return "video/mp2t";
  if (e === ".webm") return "video/webm";
  if (e === ".mp4" || e === ".m4v") return "video/mp4";
  if (e === ".mov" || e === ".qt") return "video/quicktime";
  if (e === ".ogv") return "video/ogg";
  if (e === ".wmv") return "video/x-ms-wmv";
  if (e === ".asf" || e === ".wm") return "video/x-ms-asf";
  return "";
}

ipcMain.handle("iptv-pick-local-video-files", async () => {
  const { pathToFileURL } = require("url");
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Video",
        extensions: [
          "mp4",
          "webm",
          "mkv",
          "mov",
          "m4v",
          "ogv",
          "avi",
          "divx",
          "wmv",
          "mpeg",
          "mpg",
          "mpe",
          "mpv",
          "m1v",
          "m2v",
          "m2ts",
          "mts",
          "ts",
          "asf",
          "wm",
        ],
      },
      { name: "All files", extensions: ["*"] },
    ],
    title: "RJ IPTV — add local video files",
  });
  if (r.canceled || !r.filePaths?.length) return [];
  const fsp = fs.promises;
  const out = [];
  for (const fp of r.filePaths) {
    let stat;
    try {
      stat = await fsp.stat(fp);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const ext = path.extname(fp);
    const base = path.basename(fp);
    const name =
      ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base;
    const fpNorm = path.resolve(fp);
    const h = crypto
      .createHash("sha256")
      .update(`${fpNorm}\0${stat.size}\0${Number(stat.mtimeMs)}`)
      .digest("hex")
      .slice(0, 40);
    let href;
    try {
      href = pathToFileURL(fpNorm).href;
    } catch {
      continue;
    }
    const mime = mimeForLocalVideoExt(ext) || undefined;
    out.push({
      id: `local-video-${h}`,
      name,
      url: href,
      mime,
      originalFileName: base,
    });
  }
  return out;
});

function getBundledFfmpegPath() {
  try {
    let p = require("ffmpeg-static");
    if (typeof p !== "string" || !p.trim()) return null;
    p = path.normalize(p.trim());
    if (p.includes(`${path.sep}app.asar${path.sep}`) && !p.includes(`${path.sep}app.asar.unpacked${path.sep}`)) {
      const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
      if (fs.existsSync(unpacked)) p = unpacked;
    }
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const stderrChunks = [];
    const child = spawn(ffmpegPath, args, { windowsHide: process.platform === "win32" });
    child.stderr?.on("data", (d) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = Buffer.concat(stderrChunks)
          .toString("utf8")
          .replace(/\r/g, "")
          .trim()
          .slice(-1400);
        reject(new Error(tail ? `ffmpeg exited ${code}: ${tail}` : `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/**
 * Matroska (.mkv) often uses codecs Chromium cannot decode (HEVC, DTS, etc.). Remux or transcode to H.264/AAC MP4
 * via bundled ffmpeg-static (first open may take a while; result is cached under the user temp folder).
 */
ipcMain.handle("iptv-prepare-mkv-playback", async (_evt, fileUrlRaw) => {
  const fileUrl = String(fileUrlRaw ?? "").trim();
  if (!/^file:/i.test(fileUrl)) {
    return { playUrl: fileUrl, mimeType: "video/mp4", usedTranscode: false };
  }
  let inPath;
  try {
    inPath = fileURLToPath(fileUrl);
  } catch {
    throw new Error("Invalid file URL.");
  }
  const ext = path.extname(inPath).toLowerCase();
  if (ext !== ".mkv" && ext !== ".mka") {
    return { playUrl: fileUrl, mimeType: undefined, usedTranscode: false };
  }

  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not bundled with this app. MKV playback needs a packaged desktop build with ffmpeg-static."
    );
  }

  const fsp = fs.promises;
  let st;
  try {
    st = await fsp.stat(inPath);
  } catch {
    throw new Error("Could not read the video file from disk.");
  }
  if (!st.isFile() || st.size === 0) throw new Error("Video file is missing or empty.");

  const fpNorm = path.resolve(inPath);
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${fpNorm}\0${st.size}\0${Number(st.mtimeMs)}`)
    .digest("hex")
    .slice(0, 48);
  const cacheDir = path.join(app.getPath("temp"), "rj-iptv-mkv-cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${cacheKey}.mp4`);

  try {
    const ost = await fsp.stat(outPath);
    if (ost.size > 32_000) {
      return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: true, fromCache: true };
    }
  } catch {
    /* build */
  }

  const tryUnlink = async (p) => {
    try {
      await fsp.unlink(p);
    } catch {
      /* noop */
    }
  };

  await tryUnlink(outPath);

  const baseArgs = ["-nostdin", "-hide_banner", "-loglevel", "warning", "-y", "-i", fpNorm];

  const copyWithAudio = ["-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart"];
  const copyVideoOnly = ["-map", "0:v:0", "-c", "copy", "-an", "-movflags", "+faststart"];
  const x264aac = [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "192k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
  ];
  const x264an = ["-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-an", "-movflags", "+faststart"];

  const tryEncode = async (extraArgs) => {
    await tryUnlink(outPath);
    await runFfmpeg(ffmpegPath, [...baseArgs, ...extraArgs, outPath]);
  };

  try {
    await tryEncode(copyWithAudio);
    return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: false, remuxed: true };
  } catch {
    await tryUnlink(outPath);
  }

  try {
    await tryEncode(copyVideoOnly);
    return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: false, remuxed: true };
  } catch {
    await tryUnlink(outPath);
  }

  try {
    await tryEncode(x264aac);
    return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: true };
  } catch {
    await tryUnlink(outPath);
  }

  await tryEncode(x264an);
  return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: true };
});

function attachRecordingFanout(id, upstream, ws, filePath, tapMime) {
  const handle = { upstream, ws, filePath, tapRes: null, tapMime: tapMime || "video/mp2t" };
  const bp = { fileOk: true, tapOk: true };

  const resumeIfReady = () => {
    if (!upstream.isPaused()) return;
    if (bp.fileOk && bp.tapOk) upstream.resume();
  };

  const fail = () => {
    teardownRecording(id, true);
  };

  upstream.on("data", (chunk) => {
    bp.fileOk = ws.write(chunk) !== false;
    if (handle.tapRes && !handle.tapRes.writableEnded) {
      try {
        bp.tapOk = handle.tapRes.write(chunk) !== false;
      } catch {
        bp.tapOk = true;
        try {
          handle.tapRes.removeAllListeners("drain");
          handle.tapRes.destroy();
        } catch {
          /* noop */
        }
        handle.tapRes = null;
      }
    } else {
      bp.tapOk = true;
    }
    if (!bp.fileOk || !bp.tapOk) upstream.pause();
  });

  upstream.on("error", fail);
  ws.on("error", fail);

  upstream.on("end", () => {
    try {
      ws.end();
    } catch {
      /* noop */
    }
    try {
      if (handle.tapRes && !handle.tapRes.writableEnded) {
        handle.tapRes.removeAllListeners("drain");
        handle.tapRes.end();
      }
    } catch {
      /* noop */
    }
    streamRecordings.delete(id);
  });

  ws.on("drain", () => {
    bp.fileOk = true;
    resumeIfReady();
  });

  handle._onTapDrain = () => {
    bp.tapOk = true;
    resumeIfReady();
  };

  streamRecordings.set(id, handle);
}

function teardownRecording(id, removeMap) {
  const h = streamRecordings.get(id);
  if (!h) return;
  try {
    h.upstream.destroy();
  } catch {
    /* noop */
  }
  try {
    h.ws.end();
  } catch {
    /* noop */
  }
  try {
    if (h.tapRes && !h.tapRes.writableEnded) {
      h.tapRes.removeAllListeners("drain");
      h.tapRes.end();
    }
  } catch {
    /* noop */
  }
  if (removeMap) streamRecordings.delete(id);
}

ipcMain.handle("iptv-start-stream-record", async (_evt, payload) => {
  const outDir = typeof payload?.outDir === "string" ? payload.outDir.trim() : "";
  if (!outDir) throw new Error("No output folder.");
  const url = assertPlaylistUrlForMain(payload?.url);
  if (isLikelyHlsRecordUrl(url)) {
    throw new Error(
      "HLS (.m3u8) cannot be saved as one raw .mpeg file from this app. Use a continuous TS-style URL or record with ffmpeg/VLC."
    );
  }
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tapMime = normalizeRecordTapMime(payload?.tapContentType);
  const filenameExt = normalizeRecordFilenameExt(payload?.filenameExt);
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}${filenameExt}`;
  const filePath = path.join(outDir, name);
  const ws = fs.createWriteStream(filePath, { flags: "w", highWaterMark: 4 * 1024 * 1024 });
  let res;
  try {
    res = await net.fetch(url, { headers: streamRecordHeaders(url) });
  } catch (e) {
    ws.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
    throw new Error(e instanceof Error ? e.message : "Network error");
  }
  if (!res.ok) {
    ws.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.body) {
    ws.end();
    return { ok: true, id, filePath, playbackUrl: null };
  }
  const upstream = Readable.fromWeb(res.body);
  attachRecordingFanout(id, upstream, ws, filePath, tapMime);
  const playbackUrl =
    rendererOrigin != null ? `${rendererOrigin}/__tap/stream?id=${encodeURIComponent(id)}` : null;
  return { ok: true, id, filePath, playbackUrl };
});

ipcMain.handle("iptv-stop-stream-record", async (_evt, id) => {
  const h = streamRecordings.get(id);
  if (!h) return { ok: true };
  teardownRecording(id, true);
  return { ok: true, filePath: h.filePath };
});

/** Reveal the recorded file in Finder / File Explorer / file manager. */
ipcMain.handle("iptv-show-record-in-folder", async (_evt, rawPath) => {
  const fp = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!fp) throw new Error("No file path.");
  const resolved = path.resolve(fp);
  if (resolved.length < 4) throw new Error("Invalid path.");
  shell.showItemInFolder(resolved);
  return { ok: true };
});

app.on("before-quit", () => {
  for (const id of [...streamRecordings.keys()]) {
    teardownRecording(id, true);
  }
});

app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      callback(false);
      return;
    }
  } catch {
    callback(false);
    return;
  }
  /* Many IPTV panels use HTTPS with incomplete chains / self-signed certs. */
  event.preventDefault();
  callback(true);
});

/** Many IPTV CDNs reject the default Electron/Chromium UA on media XHR. */
function installStreamRequestHeaderTweaks() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const { url } = details;
    if (
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost") ||
      url.startsWith("devtools://") ||
      url.startsWith("chrome-extension://")
    ) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const headers = { ...details.requestHeaders };
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
    if (!headers["User-Agent"] && !headers["User-agent"]) {
      headers["User-Agent"] = ua;
    }
    if (!headers.Referer && !headers.referer) {
      try {
        const u = new URL(url);
        headers.Referer = `${u.protocol}//${u.host}/`;
      } catch {
        /* ignore */
      }
    }
    callback({ requestHeaders: headers });
  });
}

/**
 * Chromium and Firefox apply CORS to fetch() (mpegts.js). Many IPTV hosts omit
 * Access-Control-Allow-Origin, so the renderer cannot read the body. We also
 * patch responses for direct cross-origin fetches (e.g. HLS). MPEG-TS is
 * proxied through /__proxy/stream on the local static server when possible.
 */
function installStreamResponseCorsPatch() {
  const resourceTypes = new Set(["xhr", "media", "other", "ping"]);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const { url } = details;
    if (
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost") ||
      url.startsWith("devtools://")
    ) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!resourceTypes.has(details.resourceType)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const rh = { ...details.responseHeaders };
    for (const key of Object.keys(rh)) {
      if (key.toLowerCase() === "cross-origin-resource-policy") {
        delete rh[key];
      }
    }
    const lower = Object.fromEntries(
      Object.entries(rh).map(([k, v]) => [k.toLowerCase(), v])
    );
    if (!lower["access-control-allow-origin"]) {
      rh["Access-Control-Allow-Origin"] = ["*"];
    }
    callback({ responseHeaders: rh });
  });
}

function installElectronNetworkCompat() {
  installStreamRequestHeaderTweaks();
  installStreamResponseCorsPatch();
}

function distDir() {
  return path.join(__dirname, "..", "dist");
}

function assertStreamProxyTarget(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("Invalid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) targets are allowed.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "169.254.169.254" || h === "metadata.google.internal") {
    throw new Error("Host blocked.");
  }
  return u.toString();
}

async function tryServeStreamProxy(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (u.pathname !== "/__proxy/stream") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed");
    return true;
  }
  const target = u.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing url query parameter.");
    return true;
  }
  let validated;
  try {
    validated = assertStreamProxyTarget(target);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(e.message);
    return true;
  }
  const tObj = new URL(validated);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    Referer: `${tObj.origin}/`,
  };
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  let up;
  try {
    up = await net.fetch(validated, { method: req.method, headers });
  } catch (e) {
    res
      .writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
      .end(e instanceof Error ? e.message : "Upstream fetch failed");
    return true;
  }

  const out = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const ct = up.headers.get("content-type");
  if (ct) out["Content-Type"] = ct;
  const cl = up.headers.get("content-length");
  if (cl) out["Content-Length"] = cl;
  const cr = up.headers.get("content-range");
  if (cr) out["Content-Range"] = cr;
  const ar = up.headers.get("accept-ranges");
  if (ar) out["Accept-Ranges"] = ar;

  if (req.method === "HEAD" || up.status === 204 || !up.body) {
    res.writeHead(up.status, out).end();
    return true;
  }

  res.writeHead(up.status, out);
  const nodeStream = Readable.fromWeb(up.body);
  nodeStream.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  });
  nodeStream.pipe(res);
  return true;
}

/** Live fan-out of the single upstream used for recording: same bytes as disk, for the in-page player. */
async function tryServeStreamTap(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (u.pathname !== "/__tap/stream") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed");
    return true;
  }

  const id = u.searchParams.get("id");
  if (!id) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing id query parameter.");
    return true;
  }

  const handle = streamRecordings.get(id);
  if (!handle) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Recording session not found.");
    return true;
  }

  if (req.method === "HEAD") {
    const tapCt = handle.tapMime || "video/mp2t";
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": tapCt,
    });
    res.end();
    return true;
  }

  if (handle.tapRes && !handle.tapRes.writableEnded) {
    try {
      handle.tapRes.removeAllListeners("drain");
      handle.tapRes.removeAllListeners("close");
      handle.tapRes.destroy();
    } catch {
      /* noop */
    }
    handle.tapRes = null;
  }

  const tapCt = handle.tapMime || "video/mp2t";
  const out = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": tapCt,
  };
  res.writeHead(200, out);
  handle.tapRes = res;
  res.on("drain", handle._onTapDrain);
  res.once("close", () => {
    if (handle.tapRes === res) {
      try {
        res.removeAllListeners("drain");
      } catch {
        /* noop */
      }
      handle.tapRes = null;
    }
  });
  handle._onTapDrain();
  return true;
}

function safeFilePath(root, reqUrl) {
  let pathname = "/";
  try {
    pathname = new URL(reqUrl, "http://127.0.0.1").pathname || "/";
  } catch {
    return null;
  }
  if (pathname === "/__proxy/stream" || pathname === "/__tap/stream") return null;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = path.resolve(path.join(root, rel));
  const rootResolved = path.resolve(root);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (full !== rootResolved && !full.startsWith(prefix)) return null;
  return full;
}

/** Same origin each launch → browser localStorage for channels/favorites persists. */
const STATIC_SERVER_PREFERRED_PORT = 48752;
const STATIC_SERVER_PORT_TRIES = 40;

function createStaticRequestHandler(root) {
  return (req, res) => {
    void (async () => {
      try {
        if (await tryServeStreamTap(req, res)) return;
        if (await tryServeStreamProxy(req, res)) return;
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(e instanceof Error ? e.message : "Proxy error");
        return;
      }

      const filePath = safeFilePath(root, req.url || "/");
      if (!filePath) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end("Not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.writeHead(200).end(data);
      });
    })();
  };
}

function startStaticServers(root) {
  const requestHandler = createStaticRequestHandler(root);

  function listenOnPort(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(requestHandler);
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        server.on("error", (err) => {
          console.error("IPTV static server error:", err);
        });
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolve({ server, url: `http://127.0.0.1:${actualPort}/` });
      });
    });
  }

  return (async () => {
    for (let i = 0; i < STATIC_SERVER_PORT_TRIES; i++) {
      const port1 = STATIC_SERVER_PREFERRED_PORT + i;
      try {
        const first = await listenOnPort(port1);
        let second = null;
        for (let k = 1; k <= 96; k++) {
          try {
            second = await listenOnPort(port1 + k);
            break;
          } catch (e) {
            if (e && e.code === "EADDRINUSE") continue;
            throw e;
          }
        }
        if (!second) {
          try {
            second = await listenOnPort(0);
          } catch {
            /* one server only */
          }
        }
        const servers = [first.server];
        const origins = [new URL(first.url).origin];
        if (second) {
          servers.push(second.server);
          origins.push(new URL(second.url).origin);
        } else {
          origins.push(origins[0]);
        }
        streamProxyOriginsForIpc = origins;
        return { servers, appUrl: first.url, streamProxyOrigins: origins };
      } catch (e) {
        if (e && e.code === "EADDRINUSE") continue;
        throw e;
      }
    }
    const first = await listenOnPort(0);
    let second = null;
    try {
      second = await listenOnPort(0);
    } catch {
      /* noop */
    }
    const servers = [first.server];
    const origins = [new URL(first.url).origin];
    if (second) {
      servers.push(second.server);
      origins.push(new URL(second.url).origin);
    } else {
      origins.push(origins[0]);
    }
    streamProxyOriginsForIpc = origins;
    return { servers, appUrl: first.url, streamProxyOrigins: origins };
  })();
}

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const p = windowStateFile();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function clampWindowBounds(raw) {
  if (!raw || typeof raw.width !== "number" || typeof raw.height !== "number") return null;
  const primary = screen.getPrimaryDisplay();
  const WA = primary.workArea;
  const minW = 900;
  const minH = 600;
  const width = Math.max(minW, Math.min(Math.floor(raw.width), WA.width));
  const height = Math.max(minH, Math.min(Math.floor(raw.height), WA.height));
  let x = typeof raw.x === "number" ? Math.floor(raw.x) : WA.x;
  let y = typeof raw.y === "number" ? Math.floor(raw.y) : WA.y;
  const minVisible = 120;
  if (x + width < WA.x + minVisible) x = WA.x;
  if (x > WA.x + WA.width - minVisible) x = WA.x + WA.width - width;
  if (y + height < WA.y + minVisible) y = WA.y;
  if (y > WA.y + WA.height - minVisible) y = WA.y + WA.height - height;
  return { x, y, width, height, isMaximized: !!raw.isMaximized };
}

/** First launch or missing window-state: fill primary monitor work area at native resolution. */
function defaultWindowBoundsFromDisplay() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x,
    y: wa.y,
    width: Math.max(900, Math.floor(wa.width)),
    height: Math.max(600, Math.floor(wa.height)),
    isMaximized: true,
  };
}

function installAppMenu() {
  const isMac = process.platform === "darwin";
  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { label: "File", submenu: [{ role: "close" }] },
        ]
      : [{ label: "File", submenu: [{ role: "quit", label: "Exit" }] }]),
    editMenu,
    {
      label: "View",
      submenu: [{ role: "togglefullscreen", label: "Full screen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Right-click: copy/paste and link actions (Chromium does not show a menu without this in Electron). */
function installWebContentsContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const ef = params.editFlags || {};
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [];

    if (params.linkURL?.trim()) {
      try {
        const u = params.linkURL.trim();
        new URL(u);
        template.push({
          label: "Open link in browser",
          click: () => void shell.openExternal(u),
        });
        template.push({
          label: "Copy link address",
          click: () => clipboard.writeText(u),
        });
        template.push({ type: "separator" });
      } catch {
        /* ignore malformed link */
      }
    }

    if (params.selectionText && String(params.selectionText).trim() && !ef.canCopy) {
      template.push({
        label: "Copy",
        click: () => clipboard.writeText(String(params.selectionText)),
      });
    }

    if (ef.canUndo) template.push({ role: "undo" });
    if (ef.canRedo) template.push({ role: "redo" });
    if (ef.canUndo || ef.canRedo) template.push({ type: "separator" });

    if (ef.canCut) template.push({ role: "cut" });
    if (ef.canCopy) template.push({ role: "copy" });
    if (ef.canPaste) template.push({ role: "paste" });
    if (process.platform === "darwin" && ef.canPaste) {
      template.push({ role: "pasteAndMatchStyle" });
    }
    if (ef.canDelete) template.push({ role: "delete" });
    if (ef.canSelectAll) {
      if (template.length) template.push({ type: "separator" });
      template.push({ role: "selectAll" });
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const data = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      isMaximized: win.isMaximized(),
    };
    fs.writeFileSync(windowStateFile(), JSON.stringify(data));
  } catch {
    /* noop */
  }
}

async function createWindow() {
  const root = distDir();
  if (!fs.existsSync(path.join(root, "index.html"))) {
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "RJ IPTV and Online Radio Player",
      "Built UI not found (missing dist/index.html). Run npm run build first, then rebuild the desktop app."
    );
    app.quit();
    return;
  }

  const { servers, appUrl, streamProxyOrigins } = await startStaticServers(root);
  staticServers = servers;
  try {
    rendererOrigin = new URL(appUrl).origin;
  } catch {
    rendererOrigin = null;
  }

  const preloadPath = path.join(__dirname, "preload.cjs");

  const wb = clampWindowBounds(loadWindowState()) ?? defaultWindowBoundsFromDisplay();

  const win = new BrowserWindow({
    width: wb.width,
    height: wb.height,
    x: wb.x,
    y: wb.y,
    minWidth: 900,
    minHeight: 600,
    title: "RJ IPTV and Online Radio Player",
    fullscreenable: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      /* Spellcheck builds a large dictionary in the renderer; IPTV UI is not document editing. */
      spellcheck: false,
      /* IPTV streams and M3U hosts often lack CORS; desktop shell matches typical IPTV desktop players. */
      webSecurity: false,
    },
    show: false,
  });

  installWebContentsContextMenu(win);

  win.once("ready-to-show", () => {
    if (wb.isMaximized) win.maximize();
    win.show();
  });
  await win.loadURL(appUrl);

  win.on("close", () => saveWindowState(win));

  win.on("closed", () => {
    for (const s of staticServers) {
      try {
        s.close();
      } catch {
        /* noop */
      }
    }
    staticServers = [];
  });
}

app.whenReady().then(() => {
  installElectronNetworkCompat();
  installAppMenu();
  return createWindow();
});

app.on("window-all-closed", () => {
  for (const s of staticServers) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  staticServers = [];
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
