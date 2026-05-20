/**
 * Player — Electron shell.
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
const nodeNet = require("net");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
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
let streamProxySessionToken = null;
let splitScreenPreferenceEnabled = false;
/** Exact recording output files the renderer may reveal in the file manager. */
const allowedRecordRevealPaths = new Set();
/** Recording output folders chosen in the native picker. */
const allowedRecordOutputDirs = new Set();

const BLOCKED_FETCH_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
]);

function parseIpv4Host(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/** Block loopback, link-local, and cloud metadata. RFC1918 LAN hosts stay allowed for IPTV. */
function isBlockedFetchHostname(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (BLOCKED_FETCH_HOSTNAMES.has(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = parseIpv4Host(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function assertSafeFetchUrl(raw, label = "URL") {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) ${label} is supported.`);
  }
  if (isBlockedFetchHostname(u.hostname)) {
    throw new Error("That host is not allowed.");
  }
  if (u.username || u.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  return u.toString();
}

function assertPlaylistUrlForMain(raw) {
  return assertSafeFetchUrl(raw, "playlist URL");
}

function assertStreamProxySessionToken(reqUrl) {
  if (!streamProxySessionToken) return;
  let u;
  try {
    u = new URL(reqUrl || "/", "http://127.0.0.1");
  } catch {
    throw new Error("Invalid proxy request.");
  }
  const token = u.searchParams.get("token");
  if (token !== streamProxySessionToken) {
    throw new Error("Forbidden.");
  }
}

function assertUserAccessibleMediaPath(resolvedPath) {
  const resolved = path.resolve(resolvedPath);
  const roots = [
    app.getPath("home"),
    app.getPath("videos"),
    app.getPath("music"),
    app.getPath("downloads"),
    app.getPath("documents"),
    app.getPath("desktop"),
    app.getPath("temp"),
  ]
    .map((p) => {
      try {
        return path.resolve(p);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error("Media file must be under your user folders.");
  }
  return resolved;
}

function assertAllowedRecordRevealPath(rawPath) {
  const resolved = path.resolve(String(rawPath ?? "").trim());
  if (resolved.length < 4) throw new Error("Invalid path.");
  if (allowedRecordRevealPaths.has(resolved)) return resolved;
  for (const dir of allowedRecordOutputDirs) {
    if (resolved === dir || resolved.startsWith(`${dir}${path.sep}`)) return resolved;
  }
  throw new Error("That file path is not from an app recording.");
}

const APP_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:* https:; media-src 'self' blob: file: http: https:; connect-src 'self' http://127.0.0.1:* https: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-src https:; form-action 'none';";

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
const GEMINI_KEY_PATH = () => path.join(app.getPath("userData"), "gemini-api-key.txt");
const GEMINI_MODEL_PATH = () => path.join(app.getPath("userData"), "gemini-model.txt");

function getLyricsChatTranslateApiKey() {
  // Priority: saved Settings file → `.env` / shell env. This lets users test an in-app key
  // without restarting Electron after editing `.env`.
  const saved = getSavedLyricsChatTranslateApiKey();
  if (saved) return saved;
  return getLyricsChatTranslateEnvApiKey();
}

function getLyricsChatTranslateEnvApiKey() {
  return String(
    process.env.DEEPSEEK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.OPENAI_COMPATIBLE_LYRICS_API_KEY ??
      ""
  ).trim();
}

function getSavedLyricsChatTranslateApiKey() {
  return readSavedLyricsChatText(LYRICS_CHAT_KEY_PATH);
}

function getSavedGeminiApiKey() {
  return readSavedLyricsChatText(GEMINI_KEY_PATH);
}

function readSavedLyricsChatText(pathFn) {
  try {
    const p = pathFn();
    if (fs.existsSync(p)) {
      const t = String(fs.readFileSync(p, "utf8") ?? "").trim();
      if (t) return t;
    }
  } catch {
    /* noop */
  }
  return "";
}

function maskApiKeyForPreview(raw) {
  const key = String(raw ?? "").trim();
  if (!key) return "";
  if (key.length <= 6) return "x".repeat(key.length);
  return `${key.slice(0, 3)}${"x".repeat(Math.max(4, key.length - 6))}${key.slice(-3)}`;
}

function getLyricsChatTranslateKeyStatusDetails() {
  const envKey = getLyricsChatTranslateEnvApiKey();
  const savedKey = getSavedLyricsChatTranslateApiKey();
  const activeKey = savedKey || envKey;
  return {
    key: activeKey,
    keySource: savedKey ? "app" : envKey ? "env" : "",
    keyPreview: maskApiKeyForPreview(activeKey),
  };
}

function getGeminiApiKeyFromEnv() {
  return String(
    process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_AI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      ""
  ).trim();
}

function getGeminiApiKey() {
  const saved = getSavedGeminiApiKey();
  if (saved) return saved;
  return getGeminiApiKeyFromEnv();
}

function getGeminiKeyStatusDetails() {
  const envKey = getGeminiApiKeyFromEnv();
  const savedKey = getSavedGeminiApiKey();
  const activeKey = savedKey || envKey;
  return {
    key: activeKey,
    keySource: savedKey ? "app" : envKey ? "env" : "",
    keyPreview: maskApiKeyForPreview(activeKey),
  };
}

function getLyricsChatTranslateBaseUrlRaw() {
  if (getSavedLyricsChatTranslateApiKey()) {
    return readSavedLyricsChatText(LYRICS_CHAT_BASE_URL_PATH);
  }
  const fromEnv = String(process.env.OPENAI_COMPATIBLE_LYRICS_BASE_URL ?? "").trim();
  if (fromEnv) return fromEnv;
  return readSavedLyricsChatText(LYRICS_CHAT_BASE_URL_PATH);
}

function getLyricsChatTranslateModelRaw() {
  if (getSavedLyricsChatTranslateApiKey()) {
    return readSavedLyricsChatText(LYRICS_CHAT_MODEL_PATH);
  }
  const fromEnv = String(process.env.OPENAI_COMPATIBLE_LYRICS_MODEL ?? "").trim();
  if (fromEnv) return fromEnv;
  return readSavedLyricsChatText(LYRICS_CHAT_MODEL_PATH);
}

function getGeminiModelRaw() {
  const savedKey = getSavedGeminiApiKey();
  const raw = savedKey
    ? readSavedLyricsChatText(GEMINI_MODEL_PATH)
    : String(process.env.GEMINI_MODEL ?? process.env.GOOGLE_AI_MODEL ?? "").trim() ||
      readSavedLyricsChatText(GEMINI_MODEL_PATH);
  const core = (raw || "gemini-2.5-flash").replace(/^models\//, "");
  if (core.length > 96 || !/^[a-zA-Z0-9._-]+$/.test(core)) {
    throw new Error("Invalid Gemini model id.");
  }
  return core;
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

function buildLyricsIdentityUserPrompt(p, extraLines = []) {
  const metaArtist = typeof p.metaArtist === "string" ? p.metaArtist.trim().slice(0, 200) : "";
  const metaTitle = typeof p.metaTitle === "string" ? p.metaTitle.trim().slice(0, 200) : "";
  const metaAlbum = typeof p.metaAlbum === "string" ? p.metaAlbum.trim().slice(0, 200) : "";
  const displayName = typeof p.displayName === "string" ? p.displayName.trim().slice(0, 400) : "";
  const sourceFileName = typeof p.sourceFileName === "string" ? p.sourceFileName.trim().slice(0, 240) : "";
  const altArtist = typeof p.altArtist === "string" ? p.altArtist.trim().slice(0, 200) : "";
  const altTitle = typeof p.altTitle === "string" ? p.altTitle.trim().slice(0, 200) : "";
  const playerHeaderLabel =
    typeof p.playerHeaderLabel === "string" ? p.playerHeaderLabel.trim().slice(0, 240) : "";
  const durationSec =
    typeof p.durationSec === "number" && Number.isFinite(p.durationSec) && p.durationSec >= 0
      ? Math.floor(p.durationSec)
      : null;
  const altLine =
    altArtist || altTitle
      ? `Alternative artist/title from file or library name (use when tags look corrupted or misspelled): ${[altArtist, altTitle].filter(Boolean).join(" - ")}`
      : "";

  const panelHeader =
    playerHeaderLabel ||
    (metaArtist && metaTitle ? `${metaArtist} — ${metaTitle}` : metaTitle || metaArtist || "");

  return [
    displayName ? `Library display name: ${displayName}` : "",
    panelHeader ? `Name shown at top of lyrics panel: ${panelHeader}` : "",
    `Artist from file tags (ID3 / FLAC Vorbis / MP4): ${metaArtist || "unknown"}`,
    `Title from file tags: ${metaTitle || "unknown"}`,
    metaAlbum ? `Album from file tags: ${metaAlbum}` : "",
    sourceFileName ? `Original file name on disk: ${sourceFileName}` : "",
    altLine,
    `Approximate duration (seconds): ${durationSec != null ? String(durationSec) : "unknown"}`,
    "",
    "Use the library display name and lyrics panel title above when they match what a listener would search (e.g. on Google).",
    "Identify the correct song using the tagged artist and title when they look trustworthy.",
    'If the tagged title looks misspelled, garbled, or not a real song title, prefer the library display name, panel title, file name, or alternative artist/title above (same spelling as a Google search: "Artist - Title").',
    "Return lyrics only for that exact recording, not a remix, live version, or different song unless clearly indicated.",
    ...extraLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseGeminiLyricsMeaningJsonText(text, displayName) {
  let obj;
  const raw = stripLlmMarkdownFences(text);
  try {
    obj = JSON.parse(raw);
  } catch (firstErr) {
    const i = raw.indexOf("{");
    const j = raw.lastIndexOf("}");
    if (i < 0 || j <= i) {
      throw new Error("Gemini lyrics: response was not valid JSON.");
    }
    try {
      obj = JSON.parse(raw.slice(i, j + 1));
    } catch {
      const detail = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(`Gemini lyrics: response JSON was malformed (${detail}). Try Gemini lyrics again.`);
    }
  }
  const parsed = parseLlmUnifiedLyricsJsonText(JSON.stringify(obj), displayName);
  const meaning =
    obj && typeof obj === "object" && typeof obj.meaning === "string"
      ? obj.meaning.trim().slice(0, 6000)
      : "";
  return { ...parsed, meaning };
}

function previewLyricsChatBaseHost() {
  const base = getLyricsChatTranslateBaseUrlRaw();
  try {
    if (base) return new URL(base).host;
    return "api.deepseek.com (default)";
  } catch {
    return "(invalid saved URL)";
  }
}

function previewGeminiModel(hasGeminiKey) {
  if (!hasGeminiKey) return "";
  try {
    return getGeminiModelRaw();
  } catch {
    return "(invalid model)";
  }
}

ipcMain.handle("iptv-lyrics-chat-translate-key-status", async () => {
  const keyStatus = getLyricsChatTranslateKeyStatusDetails();
  const hasKey = !!keyStatus.key;
  const geminiStatus = getGeminiKeyStatusDetails();
  const hasGeminiKey = !!geminiStatus.key;
  const hasSongMeaningKey = hasKey || hasGeminiKey;
  const model = getLyricsChatTranslateModelRaw();
  return {
    hasKey,
    hasSongMeaningKey,
    hasGeminiFromEnv: geminiStatus.keySource === "env",
    hasGeminiKey,
    geminiKeyPreview: geminiStatus.keyPreview,
    geminiKeySource: geminiStatus.keySource,
    geminiModelPreview: previewGeminiModel(hasGeminiKey),
    keyPreview: keyStatus.keyPreview,
    keySource: keyStatus.keySource,
    apiBasePreview: previewLyricsChatBaseHost(),
    modelPreview: model || "deepseek-chat (default)",
  };
});

ipcMain.handle("iptv-lyrics-chat-translate-save-credentials", async (_evt, raw) => {
  const p = raw && typeof raw === "object" ? raw : {};
  const hasOpenAiPayload =
    Object.prototype.hasOwnProperty.call(p, "key") ||
    Object.prototype.hasOwnProperty.call(p, "baseUrl") ||
    Object.prototype.hasOwnProperty.call(p, "model");
  const hasGeminiPayload =
    Object.prototype.hasOwnProperty.call(p, "geminiKey") ||
    Object.prototype.hasOwnProperty.call(p, "geminiModel");
  if (hasGeminiPayload && !hasOpenAiPayload) {
    const geminiKey = assertLyricsChatApiKeyInput(typeof p.geminiKey === "string" ? p.geminiKey : "");
    const geminiModel = assertLyricsChatModelInput(typeof p.geminiModel === "string" ? p.geminiModel : "");
    if (!geminiKey) {
      try {
        fs.unlinkSync(GEMINI_KEY_PATH());
      } catch {
        /* missing */
      }
      try {
        fs.unlinkSync(GEMINI_MODEL_PATH());
      } catch {
        /* missing */
      }
    } else {
      fs.writeFileSync(GEMINI_KEY_PATH(), geminiKey, "utf8");
      if (geminiModel) fs.writeFileSync(GEMINI_MODEL_PATH(), geminiModel, "utf8");
      else {
        try {
          fs.unlinkSync(GEMINI_MODEL_PATH());
        } catch {
          /* missing */
        }
      }
    }
    const openAi = getLyricsChatTranslateKeyStatusDetails();
    const gemini = getGeminiKeyStatusDetails();
    return {
      ok: true,
      hasKey: !!openAi.key,
      keyPreview: openAi.keyPreview,
      keySource: openAi.keySource,
      apiBasePreview: previewLyricsChatBaseHost(),
      modelPreview: getLyricsChatTranslateModelRaw() || "deepseek-chat (default)",
      hasSongMeaningKey: !!openAi.key || !!gemini.key,
      hasGeminiKey: !!gemini.key,
      geminiKeyPreview: gemini.keyPreview,
      geminiKeySource: gemini.keySource,
      geminiModelPreview: previewGeminiModel(!!gemini.key),
    };
  }
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
    const active = getLyricsChatTranslateKeyStatusDetails();
    const gemini = getGeminiKeyStatusDetails();
    const base = getLyricsChatTranslateBaseUrlRaw();
    const modelAfterClear = getLyricsChatTranslateModelRaw();
    let apiBasePreviewAfterClear = "";
    try {
      if (base) {
        apiBasePreviewAfterClear = new URL(base).host;
      } else if (active.key) {
        apiBasePreviewAfterClear = "api.deepseek.com (default)";
      }
    } catch {
      apiBasePreviewAfterClear = "(invalid saved URL)";
    }
    return {
      ok: true,
      hasKey: !!active.key,
      keyPreview: active.keyPreview,
      keySource: active.keySource,
      hasSongMeaningKey: !!active.key || !!gemini.key,
      hasGeminiKey: !!gemini.key,
      geminiKeyPreview: gemini.keyPreview,
      geminiKeySource: gemini.keySource,
      geminiModelPreview: previewGeminiModel(!!gemini.key),
      apiBasePreview: apiBasePreviewAfterClear,
      modelPreview: active.key ? modelAfterClear || "deepseek-chat (default)" : "",
    };
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
  const active = getLyricsChatTranslateKeyStatusDetails();
  const gemini = getGeminiKeyStatusDetails();
  let apiBasePreview = "";
  try {
    const u = new URL(baseUrl || "https://api.deepseek.com");
    apiBasePreview = u.host;
  } catch {
    apiBasePreview = "";
  }
  return {
    ok: true,
    hasKey: !!active.key,
    keyPreview: active.keyPreview,
    keySource: active.keySource,
    hasSongMeaningKey: !!active.key || !!gemini.key,
    hasGeminiKey: !!gemini.key,
    geminiKeyPreview: gemini.keyPreview,
    geminiKeySource: gemini.keySource,
    geminiModelPreview: previewGeminiModel(!!gemini.key),
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
  const system = [
    "You help a music player show bilingual song lyrics.",
    "You must respond with ONLY a single JSON object (no markdown fences, no commentary before or after).",
    'Shape A success: {"ok":true,"detectedFranc3":"spa","lrclibTrack":"Artist — Title","headline":"short label","pairs":[{"orig":"line in original language","en":"English line"},...]}',
    'Shape B failure: {"ok":false,"message":"one short reason","pairs":[]}',
    "detectedFranc3 must be ISO 639-3 (three lowercase letters) when you can infer language, else use \"und\".",
    "pairs: each object needs \"orig\" and \"en\" strings; same number of logical lines; no empty orig.",
    "If you are not confident you have the correct official lyrics for that exact artist and title, set ok:false.",
    "Never substitute lyrics from a different song by the same artist or a similarly titled track.",
    "Do not exceed 120 pairs. No LRC timestamps in strings.",
  ].join(" ");

  const user = buildLyricsIdentityUserPrompt(p, [
    "Find the best-matching official lyrics, then supply each line in the original language with an accurate English translation in the same array position.",
  ]);

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

/**
 * @returns `{ text }` — throws on HTTP / empty model output
 */
async function postGeminiGenerateContent(systemPrompt, userPrompt, purpose, generationConfig = {}) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("IPTV_GEMINI_NO_KEY");
  }
  const modelId = getGeminiModelRaw();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

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
      ...generationConfig,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-goog-api-key": apiKey,
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
    throw new Error(`Gemini (${purpose}): ${gm || `HTTP ${res.status}`} [model: ${modelId} @ generativelanguage.googleapis.com]`);
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
      `Gemini (${purpose}): empty or blocked response [model: ${modelId} @ generativelanguage.googleapis.com]`
    );
  }
  return stripLlmMarkdownFences(combined);
}

async function postGeminiGenerateSongMeaning(systemPrompt, userPrompt) {
  return postGeminiGenerateContent(systemPrompt, userPrompt, "song meaning", {
    temperature: 0.35,
    maxOutputTokens: 1024,
  });
}

ipcMain.handle("iptv-lyrics-gemini-unified-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const displayName = typeof p.displayName === "string" ? p.displayName.trim() : "";
  if (!displayName || displayName.length > 400) {
    throw new Error("Invalid display name for Gemini lyrics.");
  }
  const system = [
    "You help a music player show bilingual song lyrics and a short song meaning.",
    "You must respond with ONLY a single JSON object (no markdown fences, no commentary before or after).",
    'Success shape: {"ok":true,"detectedFranc3":"spa","lrclibTrack":"Artist — Title","headline":"short label","pairs":[{"orig":"line in original language","en":"English line"},...],"meaning":"2-4 short English paragraphs explaining the song"}',
    'Failure shape: {"ok":false,"message":"one short reason","pairs":[],"meaning":""}',
    "detectedFranc3 must be ISO 639-3 (three lowercase letters) when you can infer language, else use \"und\".",
    "pairs: each object needs \"orig\" and \"en\" strings; same number of logical lines; no empty orig.",
    "If you are not confident you have the correct official lyrics, set ok:false.",
    "Do not exceed 120 pairs. No LRC timestamps in strings. Do not quote or invent full extra lyrics in meaning.",
  ].join(" ");
  const user = buildLyricsIdentityUserPrompt(p, [
    "Find the best-matching official lyrics, translate each line to English, and include a concise explanation of what the song is about.",
  ]);
  const purpose = "lyrics find + translate + meaning (Google Gemini)";
  try {
    const rawText = await postGeminiGenerateContent(system, user, purpose, {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          ok: { type: "BOOLEAN" },
          detectedFranc3: { type: "STRING" },
          lrclibTrack: { type: "STRING" },
          headline: { type: "STRING" },
          pairs: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                orig: { type: "STRING" },
                en: { type: "STRING" },
              },
              required: ["orig", "en"],
            },
          },
          meaning: { type: "STRING" },
          message: { type: "STRING" },
        },
        required: ["ok", "pairs"],
      },
    });
    const parsed = parseGeminiLyricsMeaningJsonText(rawText, displayName);
    const model = getGeminiModelRaw();
    return {
      ...parsed,
      llmPurpose: "lyrics find + translate (Google Gemini)",
      llmModel: model,
      llmHost: "generativelanguage.googleapis.com",
      songMeaningLlmPurpose: "song meaning (Google Gemini)",
      songMeaningLlmModel: model,
      songMeaningLlmHost: "generativelanguage.googleapis.com",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_GEMINI_NO_KEY")) throw e;
    return {
      ok: false,
      error: msg.slice(0, 440),
      pairs: [],
      detectedFranc3: "und",
      headline: "",
      lrclibTrack: "",
      meaning: "",
      llmPurpose: "lyrics find + translate (Google Gemini)",
      llmModel: previewGeminiModel(true),
      llmHost: "generativelanguage.googleapis.com",
      songMeaningLlmPurpose: "song meaning (Google Gemini)",
      songMeaningLlmModel: previewGeminiModel(true),
      songMeaningLlmHost: "generativelanguage.googleapis.com",
    };
  }
});

ipcMain.handle("iptv-lyrics-song-meaning-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const artist = typeof p.artist === "string" ? p.artist.trim().slice(0, 200) : "";
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  const album = typeof p.album === "string" ? p.album.trim().slice(0, 200) : "";
  const displayName = typeof p.displayName === "string" ? p.displayName.trim().slice(0, 400) : "";
  const forceOpenAiCompatible = p.forceOpenAiCompatible === true;
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
  const geminiKey = getGeminiApiKey();
  if (geminiKey && !forceOpenAiCompatible) {
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
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
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
  if (/^\.(mp4|m4v|webm|ogv|mov|mpeg|mp3|aac|ogg|opus|bin)$/.test(s)) return s;
  return ".mpeg";
}

function normalizeRecordMode(raw, url, tapMime) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "hls" || s === "mpegts" || s === "raw") return s;
  if (isLikelyHlsRecordUrl(url)) return "hls";
  return tapMime === "video/mp2t" ? "mpegts" : "raw";
}

ipcMain.handle("iptv-get-stream-proxy-origins", () => ({
  origins: streamProxyOriginsForIpc ?? [],
  token: streamProxySessionToken ?? "",
}));

ipcMain.handle("iptv-set-split-screen-preference", (_evt, enabled) => {
  splitScreenPreferenceEnabled = !!enabled;
  const item = Menu.getApplicationMenu()?.getMenuItemById("split-screen-preference");
  if (item) item.checked = splitScreenPreferenceEnabled;
  return { ok: true };
});

ipcMain.handle("iptv-pick-record-dir", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Player — folder for recordings",
    buttonLabel: "Save",
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  allowedRecordOutputDirs.add(path.resolve(r.filePaths[0]));
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

function mimeForLibraryExt(ext) {
  const audio = mimeForLocalAudioExt(ext);
  if (audio) return audio;
  const e = String(ext || "").toLowerCase();
  if (e === ".pdf") return "application/pdf";
  if (e === ".epub") return "application/epub+zip";
  if (e === ".txt" || e === ".md" || e === ".markdown") return "text/plain";
  if (e === ".html" || e === ".htm" || e === ".xhtml") return "text/html";
  return "";
}

/**
 * Native folder picker + readFile in main (reliable on Windows vs renderer File / IndexedDB quirks).
 * Recursively imports supported audio, audiobook, and ebook files into the renderer IndexedDB library.
 */
const MAX_DESKTOP_LIBRARY_PICK_COUNT = 500;
const MAX_DESKTOP_LIBRARY_FILE_BYTES = 512 * 1024 * 1024;

const LIBRARY_IMPORT_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".m4b",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".flac",
  ".webm",
  ".mpga",
  ".mpeg",
  ".pdf",
  ".epub",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".xhtml",
]);

function isLibraryImportPath(fp) {
  const base = path.basename(fp);
  if (!base || base.startsWith(".")) return false;
  return LIBRARY_IMPORT_EXTENSIONS.has(path.extname(fp).toLowerCase());
}

async function collectLibraryFilePathsUnderDir(rootDir, maxCount) {
  const fsp = fs.promises;
  const out = [];
  async function walk(dir) {
    if (out.length >= maxCount) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const ent of entries) {
      if (out.length >= maxCount) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".")) continue;
        await walk(full);
      } else if (ent.isFile() && isLibraryImportPath(full)) {
        out.push(full);
      }
    }
  }
  await walk(path.resolve(rootDir));
  return out;
}

async function readLibraryPickFromPath(fp, fsp) {
  let stat;
  try {
    stat = await fsp.stat(fp);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  if (stat.size > MAX_DESKTOP_LIBRARY_FILE_BYTES) {
    return { skip: `${path.basename(fp)} exceeds ${Math.round(MAX_DESKTOP_LIBRARY_FILE_BYTES / (1024 * 1024))} MB and was skipped.` };
  }
  const ext = path.extname(fp);
  const mime = mimeForLibraryExt(ext) || "application/octet-stream";
  const base = path.basename(fp);
  const name = ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base;
  const buf = await fsp.readFile(fp);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return {
    row: {
      fileName: base,
      name,
      size: stat.size,
      lastModified: stat.mtimeMs,
      addedAt: Date.now(),
      mime,
      data: ab,
    },
  };
}

async function readLibraryPicksFromPaths(filePaths, dialog) {
  const out = [];
  const skipped = [];
  const fsp = fs.promises;
  for (const fp of filePaths) {
    if (out.length >= MAX_DESKTOP_LIBRARY_PICK_COUNT) {
      skipped.push(`Only the first ${MAX_DESKTOP_LIBRARY_PICK_COUNT} files were imported.`);
      break;
    }
    const result = await readLibraryPickFromPath(fp, fsp);
    if (!result) continue;
    if (result.skip) {
      skipped.push(result.skip);
      continue;
    }
    out.push(result.row);
  }
  if (skipped.length && dialog) {
    void dialog.showMessageBox({
      type: "warning",
      title: "Some library files were skipped",
      message: "Not every file in the folder could be added.",
      detail: skipped.slice(0, 8).join("\n"),
    });
  }
  return out;
}

ipcMain.handle("iptv-pick-local-audio-files", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Add folder to library — audio, audiobooks, ebooks",
    buttonLabel: "Add",
  });
  if (r.canceled || !r.filePaths?.[0]) return [];
  const rootDir = r.filePaths[0];
  const filePaths = await collectLibraryFilePathsUnderDir(rootDir, MAX_DESKTOP_LIBRARY_PICK_COUNT);
  if (!filePaths.length) {
    void dialog.showMessageBox({
      type: "info",
      title: "No supported files found",
      message: "That folder does not contain any supported audio, audiobook, or ebook files.",
      detail: `Supported types: ${[...LIBRARY_IMPORT_EXTENSIONS].join(", ")}`,
    });
    return [];
  }
  return readLibraryPicksFromPaths(filePaths, dialog);
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
    title: "Player — add local video files",
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

function attachFfmpegStderr(child) {
  const MAX_STDERR_BYTES = 256 * 1024;
  let stderrSize = 0;
  const stderrChunks = [];
  child.stderr?.on("data", (d) => {
    if (stderrSize >= MAX_STDERR_BYTES) return;
    stderrChunks.push(d);
    stderrSize += d.length;
  });
  return () =>
    Buffer.concat(stderrChunks)
      .toString("utf8")
      .replace(/\r/g, "")
      .trim()
      .slice(-1400);
}

function spawnFfmpegProcess(ffmpegPath, args) {
  const child = spawn(ffmpegPath, args, { windowsHide: process.platform === "win32" });
  const readStderrTail = attachFfmpegStderr(child);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = readStderrTail();
        reject(new Error(tail ? `ffmpeg exited ${code}: ${tail}` : `ffmpeg exited with code ${code}`));
      }
    });
  });
  done.catch(() => {});
  return { child, done, readStderrTail };
}

function runFfmpeg(ffmpegPath, args) {
  const { done } = spawnFfmpegProcess(ffmpegPath, args);
  return done;
}

const whisperStt = require("./whisperStt.cjs");
whisperStt.initWhisperStt({
  app,
  getFfmpegPath: getBundledFfmpegPath,
  runFfmpeg: (ffmpegPath, args) => runFfmpeg(ffmpegPath, args),
});

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mp4FileLooksPlayable(outPath) {
  const fsp = fs.promises;
  try {
    const st = await fsp.stat(outPath);
    if (st.size < 262_144) return false;
    const fh = await fsp.open(outPath, "r");
    try {
      const readLen = Math.min(st.size, 524_288);
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, 0);
      const head = buf.toString("latin1");
      const hasFtyp = head.includes("ftyp");
      const hasIndex = head.includes("moov") || head.includes("moof");
      return hasFtyp && hasIndex;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Wait until fragmented MP4 has a moov/ftyp and enough data to start `<video>` while ffmpeg still runs. */
async function waitForPlayableMp4File(outPath, child, timeoutMs) {
  const start = Date.now();
  let closedCode = null;
  child.once("close", (code) => {
    closedCode = code;
  });
  while (Date.now() - start < timeoutMs) {
    if (closedCode != null && closedCode !== 0) {
      throw new Error(`ffmpeg exited ${closedCode} before playback was ready.`);
    }
    if (await mp4FileLooksPlayable(outPath)) return;
    await sleepMs(400);
  }
  throw new Error(
    "Timed out preparing MKV for playback (the stream may be slow or blocked). Try again in a moment."
  );
}

/** Wait until FFmpeg has written an HLS playlist plus at least one playable segment. */
async function waitForPlayableHls(hlsDir, child, timeoutMs) {
  const playlistPath = path.join(hlsDir, "index.m3u8");
  const start = Date.now();
  let closedCode = null;
  if (child) {
    child.once("close", (code) => {
      closedCode = code;
    });
  }
  while (Date.now() - start < timeoutMs) {
    if (closedCode != null && closedCode !== 0) {
      throw new Error(`ffmpeg exited ${closedCode} before HLS playback was ready.`);
    }
    try {
      const pst = await fs.promises.stat(playlistPath);
      if (pst.size > 16) {
        const text = await fs.promises.readFile(playlistPath, "utf8");
        if (text.includes("#EXTINF")) {
          const names = await fs.promises.readdir(hlsDir);
          for (const name of names) {
            if (!/^seg\d+\.ts$/i.test(name)) continue;
            const segSt = await fs.promises.stat(path.join(hlsDir, name));
            if (segSt.size > 48_000) return;
          }
        }
      }
    } catch {
      /* not ready yet */
    }
    await sleepMs(400);
  }
  throw new Error(
    "Timed out preparing MKV for playback (the stream may be slow or blocked). Try again in a moment."
  );
}

const mkvPrepareInFlight = new Map();
const mkvPrepareChildren = new Map();
/** Active or recently finished MKV remux jobs — used to serve growing MP4 over HTTP Range (file:// freezes size). */
const mkvPlaybackSessions = new Map();

function mkvCacheDir() {
  return path.join(app.getPath("temp"), "rj-iptv-mkv-cache");
}

function mkvCacheFilePath(cacheKey) {
  const key = String(cacheKey ?? "").trim();
  if (!/^[a-f0-9]{48}$/i.test(key)) return null;
  const fp = path.join(mkvCacheDir(), `${key}.mp4`);
  const cacheResolved = path.resolve(mkvCacheDir());
  const fileResolved = path.resolve(fp);
  if (fileResolved !== cacheResolved && !fileResolved.startsWith(`${cacheResolved}${path.sep}`)) return null;
  return fileResolved;
}

function mkvCacheHlsDir(cacheKey) {
  const key = String(cacheKey ?? "").trim();
  if (!/^[a-f0-9]{48}$/i.test(key)) return null;
  const dir = path.join(mkvCacheDir(), key);
  const cacheResolved = path.resolve(mkvCacheDir());
  const dirResolved = path.resolve(dir);
  if (dirResolved !== cacheResolved && !dirResolved.startsWith(`${cacheResolved}${path.sep}`)) return null;
  return dirResolved;
}

function mkvHlsFilePath(cacheKey, fileName) {
  const dir = mkvCacheHlsDir(cacheKey);
  if (!dir) return null;
  const base = path.basename(String(fileName ?? ""));
  if (base !== "index.m3u8" && !/^seg\d+\.ts$/i.test(base)) return null;
  const fp = path.join(dir, base);
  if (!path.resolve(fp).startsWith(`${dir}${path.sep}`)) return null;
  return fp;
}

function mkvHttpHlsPlayUrl(cacheKey) {
  const origin = streamProxyOriginsForIpc?.[0];
  const token = streamProxySessionToken;
  const key = String(cacheKey ?? "").trim();
  if (!origin || !token || !/^[a-f0-9]{48}$/i.test(key)) return null;
  const base = String(origin).replace(/\/$/, "");
  const qs = new URLSearchParams({ token });
  return `${base}/__mkv-playback/${key}/index.m3u8?${qs.toString()}`;
}

function resolveMkvPlaybackPlayUrl(cacheKey, outPath, streaming) {
  if (streaming) {
    const httpUrl = mkvHttpHlsPlayUrl(cacheKey);
    if (httpUrl) return httpUrl;
  }
  return pathToFileURL(outPath).href;
}

function stopMkvPrepareChild(cacheKey) {
  const child = mkvPrepareChildren.get(cacheKey);
  if (!child) return;
  mkvPrepareChildren.delete(cacheKey);
  try {
    child.kill("SIGKILL");
  } catch {
    /* noop */
  }
}

const MKV_MP4_FRAG_FLAGS = ["-movflags", "frag_keyframe+empty_moov+default_base_moof"];
const MKV_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

async function cleanupMkvCache() {
  const cacheDir = mkvCacheDir();
  let entries;
  try {
    entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".mp4")) {
      const fp = path.join(cacheDir, entry.name);
      try {
        const st = await fs.promises.stat(fp);
        files.push({ fp, size: st.size, mtimeMs: st.mtimeMs, isDir: false });
      } catch {
        /* ignore */
      }
    } else if (entry.isDirectory() && /^[a-f0-9]{48}$/i.test(entry.name)) {
      const dir = path.join(cacheDir, entry.name);
      try {
        const st = await fs.promises.stat(dir);
        let dirSize = 0;
        const inner = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const f of inner) {
          if (!f.isFile()) continue;
          try {
            dirSize += (await fs.promises.stat(path.join(dir, f.name))).size;
          } catch {
            /* ignore */
          }
        }
        files.push({ fp: dir, size: dirSize, mtimeMs: st.mtimeMs, isDir: true });
      } catch {
        /* ignore */
      }
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= MKV_CACHE_MAX_BYTES) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= MKV_CACHE_MAX_BYTES * 0.8) break;
    try {
      if (file.isDir) {
        await fs.promises.rm(file.fp, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(file.fp);
      }
      total -= file.size;
    } catch {
      /* best-effort cache cleanup */
    }
  }
}

async function remuxMkvInputToCachedMp4(ffmpegPath, baseArgs, outPath, opts = {}) {
  const fsp = fs.promises;
  const tryUnlink = async (p) => {
    try {
      await fsp.unlink(p);
    } catch {
      /* noop */
    }
  };

  const movFlags = ["-movflags", "+faststart"];
  const copyWithAudio = ["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", ...movFlags];
  const copyVideoOnly = ["-map", "0:v:0?", "-c", "copy", "-an", ...movFlags];
  const x264aac = [
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
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
    ...movFlags,
  ];
  const x264an = ["-map", "0:v:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-an", ...movFlags];

  const encodeAttempts = [
    { extra: copyWithAudio, usedTranscode: false, remuxed: true },
    { extra: copyVideoOnly, usedTranscode: false, remuxed: true },
    { extra: x264aac, usedTranscode: true, remuxed: false },
    { extra: x264an, usedTranscode: true, remuxed: false },
  ];

  let lastErr = null;
  for (const attempt of encodeAttempts) {
    await tryUnlink(outPath);
    const args = [...baseArgs, ...attempt.extra, outPath];
    try {
      await runFfmpeg(ffmpegPath, args);
      return {
        playUrl: pathToFileURL(outPath).href,
        mimeType: "video/mp4",
        playbackFormat: "mp4",
        usedTranscode: attempt.usedTranscode,
        remuxed: attempt.remuxed,
      };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Could not prepare MKV for playback.");
}

/** Remote IPTV VOD: remux to growing HLS (hls.js) — avoids fragmented MP4 duration caps in `<video>`. */
async function remuxMkvInputToHls(ffmpegPath, baseArgs, hlsDir, opts = {}) {
  const fsp = fs.promises;
  const resetHlsDir = async () => {
    try {
      await fsp.rm(hlsDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    await fsp.mkdir(hlsDir, { recursive: true });
  };

  const hlsTail = [
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments+append_list+omit_endlist",
    "-hls_segment_filename",
    path.join(hlsDir, "seg%05d.ts"),
    path.join(hlsDir, "index.m3u8"),
  ];

  const copyWithAudio = ["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", ...hlsTail];
  const copyVideoOnly = ["-map", "0:v:0?", "-c", "copy", "-an", ...hlsTail];
  const x264aac = [
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
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
    ...hlsTail,
  ];
  const x264an = [
    "-map",
    "0:v:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-an",
    ...hlsTail,
  ];

  const encodeAttempts = [
    { extra: copyWithAudio, usedTranscode: false, remuxed: true },
    { extra: copyVideoOnly, usedTranscode: false, remuxed: true },
    { extra: x264aac, usedTranscode: true, remuxed: false },
    { extra: x264an, usedTranscode: true, remuxed: false },
  ];

  let lastErr = null;
  const cacheKey = opts.cacheKey;

  for (const attempt of encodeAttempts) {
    await resetHlsDir();
    const args = [...baseArgs, ...attempt.extra];
    if (cacheKey) stopMkvPrepareChild(cacheKey);
    const { child, done } = spawnFfmpegProcess(ffmpegPath, args);
    if (cacheKey) {
      mkvPrepareChildren.set(cacheKey, child);
      mkvPlaybackSessions.set(cacheKey, { hlsDir, child });
    }
    try {
      await waitForPlayableHls(hlsDir, child, opts.prepareTimeoutMs ?? 120_000);
      void done.finally(() => {
        if (cacheKey) {
          mkvPrepareChildren.delete(cacheKey);
          const session = mkvPlaybackSessions.get(cacheKey);
          if (session) session.child = null;
        }
        void cleanupMkvCache();
      });
      const httpPlayUrl = cacheKey ? mkvHttpHlsPlayUrl(cacheKey) : null;
      if (!httpPlayUrl || !/^https?:\/\//i.test(httpPlayUrl)) {
        throw new Error("MKV HLS playback URL is not ready (restart the desktop app).");
      }
      return {
        playUrl: httpPlayUrl,
        mimeType: "application/vnd.apple.mpegurl",
        playbackFormat: "hls",
        usedTranscode: attempt.usedTranscode,
        remuxed: attempt.remuxed,
        streaming: true,
      };
    } catch (e) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
      if (cacheKey) mkvPrepareChildren.delete(cacheKey);
      lastErr = e;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Could not prepare MKV for playback.");
}

function upstreamUrlFromProxyInput(inputUrl) {
  try {
    const u = new URL(inputUrl);
    if (u.pathname === "/__proxy/stream") {
      const inner = u.searchParams.get("url");
      if (inner && /^https?:\/\//i.test(inner)) return inner.trim();
    }
  } catch {
    /* noop */
  }
  return String(inputUrl ?? "").trim();
}

/** Same-origin proxy so FFmpeg can read IPTV hosts that block direct desktop fetches. */
function localProxyStreamUrl(upstreamUrl) {
  if (!/^https?:\/\//i.test(upstreamUrl)) return upstreamUrl;
  const origin = streamProxyOriginsForIpc?.[0];
  const token = streamProxySessionToken;
  if (!origin || !token) return upstreamUrl;
  const base = String(origin).replace(/\/$/, "");
  const qs = new URLSearchParams({ url: upstreamUrl, token });
  return `${base}/__proxy/stream?${qs.toString()}`;
}

function mkvRemoteInputArgs(inputUrl, headerForUrl) {
  const headersTarget = headerForUrl || inputUrl;
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-fflags",
    "+genpts",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-probesize",
    "32M",
    "-analyzeduration",
    "10M",
    "-headers",
    `${ffmpegHeaderLinesForUrl(headersTarget)}\r\n`,
    "-i",
    inputUrl,
  ];
}

/**
 * Matroska (.mkv) often uses codecs Chromium cannot decode (HEVC, DTS, AC-3, etc.). Remux or transcode to H.264/AAC MP4
 * via bundled ffmpeg-static (first open may take a while; result is cached under the user temp folder).
 * Supports local `file://` paths and remote `http(s)://` IPTV VOD links.
 */
ipcMain.handle("iptv-prepare-mkv-playback", async (_evt, fileUrlRaw) => {
  const sourceUrl =
    fileUrlRaw && typeof fileUrlRaw === "object" && typeof fileUrlRaw.url === "string"
      ? String(fileUrlRaw.url).trim()
      : String(fileUrlRaw ?? "").trim();
  if (!sourceUrl) throw new Error("Missing video URL.");

  const isFile = /^file:/i.test(sourceUrl);
  const upstreamUrl = isFile ? sourceUrl : upstreamUrlFromProxyInput(sourceUrl);
  const isRemote = /^https?:\/\//i.test(upstreamUrl);
  if (!isFile && !isRemote) {
    return { playUrl: sourceUrl, mimeType: undefined, usedTranscode: false };
  }

  let ext = "";
  let inPath = null;
  if (isFile) {
    try {
      inPath = fileURLToPath(sourceUrl);
    } catch {
      throw new Error("Invalid file URL.");
    }
    ext = path.extname(inPath).toLowerCase();
  } else {
    try {
      ext = path.extname(new URL(upstreamUrl).pathname).toLowerCase();
    } catch {
      throw new Error("Invalid stream URL.");
    }
  }

  let pathname = "";
  try {
    pathname = isFile ? inPath.replace(/\\/g, "/").toLowerCase() : new URL(upstreamUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  const isXtreamVod = /\/(movie|series)\//i.test(pathname);
  const nativeBrowserExt = new Set([".mp4", ".webm", ".m4v", ".mov"]);
  const needsRemux =
    ext === ".mkv" ||
    ext === ".mka" ||
    (isXtreamVod && !nativeBrowserExt.has(ext) && !/\.m3u8$/i.test(ext));

  if (!needsRemux) {
    return { playUrl: sourceUrl, mimeType: undefined, usedTranscode: false };
  }

  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not bundled with this app. MKV playback needs a packaged desktop build with ffmpeg-static."
    );
  }

  const fsp = fs.promises;
  let cacheKey;
  if (isFile) {
    let st;
    try {
      st = await fsp.stat(inPath);
    } catch {
      throw new Error("Could not read the video file from disk.");
    }
    if (!st.isFile() || st.size === 0) throw new Error("Video file is missing or empty.");
    const fpNorm = assertUserAccessibleMediaPath(inPath);
    cacheKey = crypto
      .createHash("sha256")
      .update(`${fpNorm}\0${st.size}\0${Number(st.mtimeMs)}`)
      .digest("hex")
      .slice(0, 48);
  } else {
    cacheKey = crypto.createHash("sha256").update(upstreamUrl).digest("hex").slice(0, 48);
  }

  const cacheDir = mkvCacheDir();
  await fsp.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${cacheKey}.mp4`);
  const hlsDir = mkvCacheHlsDir(cacheKey);

  if (isRemote && hlsDir) {
    try {
      const playlistPath = path.join(hlsDir, "index.m3u8");
      const pst = await fsp.stat(playlistPath);
      if (pst.size > 16) {
        const names = await fsp.readdir(hlsDir);
        if (names.some((n) => /^seg\d+\.ts$/i.test(n))) {
          const httpUrl = mkvHttpHlsPlayUrl(cacheKey);
          if (httpUrl) {
            return {
              playUrl: httpUrl,
              mimeType: "application/vnd.apple.mpegurl",
              playbackFormat: "hls",
              usedTranscode: false,
              fromCache: true,
              remuxed: true,
            };
          }
        }
      }
    } catch {
      /* build HLS */
    }
  }

  if (!isRemote) {
    try {
      const ost = await fsp.stat(outPath);
      if (ost.size > 32_000) {
        return {
          playUrl: pathToFileURL(outPath).href,
          mimeType: "video/mp4",
          playbackFormat: "mp4",
          usedTranscode: true,
          fromCache: true,
        };
      }
    } catch {
      /* build MP4 */
    }
  }

  const inflight = mkvPrepareInFlight.get(cacheKey);
  if (inflight) return inflight;

  const work = (async () => {
    const ffmpegInputUrl = isFile ? assertUserAccessibleMediaPath(inPath) : localProxyStreamUrl(upstreamUrl);
    const baseArgs = isFile
      ? ["-nostdin", "-hide_banner", "-loglevel", "warning", "-y", "-i", ffmpegInputUrl]
      : mkvRemoteInputArgs(ffmpegInputUrl, upstreamUrl);
    if (isRemote && hlsDir) {
      return remuxMkvInputToHls(ffmpegPath, baseArgs, hlsDir, {
        cacheKey,
        prepareTimeoutMs: 120_000,
      });
    }
    const result = await remuxMkvInputToCachedMp4(ffmpegPath, baseArgs, outPath, { cacheKey });
    void cleanupMkvCache();
    return result;
  })();

  mkvPrepareInFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    mkvPrepareInFlight.delete(cacheKey);
  }
});

function createRecordingOutput(filePath, tapMime) {
  if (tapMime !== "video/mp2t") {
    const ws = fs.createWriteStream(filePath, { flags: "w", highWaterMark: 4 * 1024 * 1024 });
    const done = new Promise((resolve, reject) => {
      ws.once("finish", resolve);
      ws.once("error", reject);
    });
    done.catch(() => {});
    return { writable: ws, done, kind: "raw" };
  }

  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("FFmpeg is required to save IPTV video recordings as MP4.");
  }
  const tmpPath = `${filePath}.recording.ts`;
  const ws = fs.createWriteStream(tmpPath, { flags: "w", highWaterMark: 16 * 1024 * 1024 });
  const done = new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("finish", () => {
      runFfmpeg(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-fflags",
        "+genpts",
        "-i",
        tmpPath,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-max_muxing_queue_size",
        "2048",
        "-movflags",
        "+faststart",
        filePath,
      ])
        .then(() => {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            /* noop */
          }
          resolve();
        })
        .catch(reject);
    });
  });
  done.catch(() => {});
  return { writable: ws, done, kind: "mp4", tmpPath };
}

function ffmpegHeaderLinesForUrl(url) {
  const headers = streamRecordHeaders(url);
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
}

function startFfmpegHlsRecording(id, url, filePath) {
  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("FFmpeg is required to record HLS (.m3u8) streams.");
  }
  const headerLines = ffmpegHeaderLinesForUrl(url);
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-headers",
    headerLines,
    "-i",
    url,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-max_muxing_queue_size",
    "2048",
    "-movflags",
    "+faststart",
    filePath,
  ];
  const child = spawn(ffmpegPath, args, { windowsHide: process.platform === "win32" });
  const stderrChunks = [];
  child.stderr?.on("data", (d) => {
    stderrChunks.push(d);
    while (stderrChunks.length > 32) stderrChunks.shift();
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      streamRecordings.delete(id);
      if (code === 0 || code === 255 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(-1200);
      reject(new Error(stderr || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
  done.catch(() => {});
  streamRecordings.set(id, {
    child,
    filePath,
    done,
    tapRes: null,
    tapMime: "application/octet-stream",
    tmpPath: null,
    upstream: null,
    ws: null,
  });
  return { ok: true, id, filePath, playbackUrl: null };
}

function attachRecordingFanout(id, upstream, recordOutput, filePath, tapMime) {
  const ws = recordOutput.writable;
  const handle = {
    upstream,
    ws,
    filePath,
    tapRes: null,
    tapMime: tapMime || "video/mp2t",
    done: recordOutput.done,
    ffmpeg: recordOutput.child || null,
    tmpPath: recordOutput.tmpPath || null,
  };
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
    if (!bp.tapOk || (!handle.tapRes && !bp.fileOk)) upstream.pause();
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
    h.upstream?.destroy();
  } catch {
    /* noop */
  }
  try {
    h.ws?.end();
  } catch {
    /* noop */
  }
  try {
    if (h.child && !h.child.killed) {
      h.child.kill("SIGINT");
      setTimeout(() => {
        try {
          if (!h.child.killed) h.child.kill("SIGTERM");
        } catch {
          /* noop */
        }
      }, 3500);
    }
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
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tapMime = normalizeRecordTapMime(payload?.tapContentType);
  const recordMode = normalizeRecordMode(payload?.recordMode, url, tapMime);
  const requestedFilenameExt = normalizeRecordFilenameExt(payload?.filenameExt);
  const filenameExt = recordMode === "hls" || recordMode === "mpegts" ? ".mp4" : requestedFilenameExt;
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}${filenameExt}`;
  const filePath = path.join(outDir, name);
  allowedRecordOutputDirs.add(path.resolve(outDir));
  allowedRecordRevealPaths.add(path.resolve(filePath));
  if (recordMode === "hls") {
    return startFfmpegHlsRecording(id, url, filePath);
  }
  const recordOutput = createRecordingOutput(filePath, recordMode === "mpegts" ? "video/mp2t" : tapMime);
  let res;
  try {
    res = await net.fetch(url, { headers: streamRecordHeaders(url) });
  } catch (e) {
    recordOutput.writable.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
    try {
      if (recordOutput.tmpPath) fs.unlinkSync(recordOutput.tmpPath);
    } catch {
      /* noop */
    }
    throw new Error(e instanceof Error ? e.message : "Network error");
  }
  if (!res.ok) {
    recordOutput.writable.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
    try {
      if (recordOutput.tmpPath) fs.unlinkSync(recordOutput.tmpPath);
    } catch {
      /* noop */
    }
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.body) {
    recordOutput.writable.end();
    return { ok: true, id, filePath, playbackUrl: null };
  }
  const upstream = Readable.fromWeb(res.body);
  attachRecordingFanout(id, upstream, recordOutput, filePath, recordMode === "mpegts" ? "video/mp2t" : tapMime);
  const playbackUrl =
    rendererOrigin != null && recordMode !== "mpegts"
      ? `${rendererOrigin}/__tap/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(streamProxySessionToken ?? "")}`
      : null;
  return { ok: true, id, filePath, playbackUrl };
});

ipcMain.handle("iptv-stop-stream-record", async (_evt, id) => {
  const h = streamRecordings.get(id);
  if (!h) return { ok: true };
  const done = h.done;
  const filePath = h.filePath;
  teardownRecording(id, true);
  if (done) {
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Recording is still finalizing. Try opening the folder in a moment.")), 120_000)
      ),
    ]);
  }
  return { ok: true, filePath };
});

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_DTYPE = "q8";
const KOKORO_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-US", gender: "female", accent: "American", grade: "A" },
  { id: "af_bella", name: "Bella", language: "en-US", gender: "female", accent: "American", grade: "A-" },
  { id: "af_nicole", name: "Nicole", language: "en-US", gender: "female", accent: "American", grade: "B-" },
  { id: "af_sarah", name: "Sarah", language: "en-US", gender: "female", accent: "American", grade: "C+" },
  { id: "am_michael", name: "Michael", language: "en-US", gender: "male", accent: "American", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", language: "en-US", gender: "male", accent: "American", grade: "C+" },
  { id: "am_puck", name: "Puck", language: "en-US", gender: "male", accent: "American", grade: "C+" },
  { id: "bf_emma", name: "Emma", language: "en-GB", gender: "female", accent: "British", grade: "B-" },
  { id: "bf_isabella", name: "Isabella", language: "en-GB", gender: "female", accent: "British", grade: "C" },
  { id: "bm_george", name: "George", language: "en-GB", gender: "male", accent: "British", grade: "C" },
  { id: "bm_fable", name: "Fable", language: "en-GB", gender: "male", accent: "British", grade: "C" },
];
const KOKORO_VOICE_IDS = new Set(KOKORO_VOICES.map((v) => v.id));
const NEURAL_TTS_MAX_TEXT_CHARS = 640;
const NEURAL_TTS_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const PIPER_VOICE_ID_PREFIX = "piper:";
let kokoroTtsPromise = null;
const neuralTtsInFlight = new Map();
let neuralTtsQueue = Promise.resolve();
let neuralTtsGeneration = 0;
let neuralTtsCleanupPromise = null;
let kokoroUnloadTimer = null;
let piperRuntimeProbePromise = null;

function neuralTtsCacheDir() {
  return path.join(app.getPath("userData"), "neural-tts-cache");
}

function neuralTtsModelCacheDir() {
  return path.join(app.getPath("userData"), "neural-tts-models");
}

function piperVoicePacksDir() {
  return path.join(app.getPath("userData"), "voice-packs");
}

function normalizeNeuralTtsText(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NEURAL_TTS_MAX_TEXT_CHARS);
}

function neuralTtsCacheKey({ text, voice, speed, style, engine = "kokoro-js", model = KOKORO_MODEL_ID }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ engine, model, dtype: engine === "kokoro-js" ? KOKORO_DTYPE : "external", voice, speed, style, text }))
    .digest("hex")
    .slice(0, 48);
}

async function loadKokoroTts() {
  if (kokoroUnloadTimer) {
    clearTimeout(kokoroUnloadTimer);
    kokoroUnloadTimer = null;
  }
  if (!kokoroTtsPromise) {
    kokoroTtsPromise = (async () => {
      process.env.OMP_NUM_THREADS ||= "1";
      process.env.ORT_NUM_THREADS ||= "1";
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = neuralTtsModelCacheDir();
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = true;
      transformers.env.useFS = true;
      transformers.env.useFSCache = true;
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: KOKORO_DTYPE,
        device: "cpu",
        session_options: {
          interOpNumThreads: 1,
          intraOpNumThreads: 1,
          executionMode: "sequential",
        },
      });
    })().catch((err) => {
      kokoroTtsPromise = null;
      throw err;
    });
  }
  return kokoroTtsPromise;
}

function scheduleKokoroUnload(delayMs = 180_000) {
  if (kokoroUnloadTimer) clearTimeout(kokoroUnloadTimer);
  kokoroUnloadTimer = setTimeout(() => {
    if (neuralTtsInFlight.size > 0) {
      scheduleKokoroUnload(delayMs);
      return;
    }
    kokoroTtsPromise = null;
    kokoroUnloadTimer = null;
    if (typeof global.gc === "function") {
      try {
        global.gc();
      } catch {
        /* gc is not normally exposed; ignore */
      }
    }
  }, delayMs);
}

async function cleanupNeuralTtsCache() {
  if (neuralTtsCleanupPromise) return neuralTtsCleanupPromise;
  neuralTtsCleanupPromise = (async () => {
    const dir = neuralTtsCacheDir();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".wav")) continue;
      const fp = path.join(dir, entry.name);
      try {
        const st = await fs.promises.stat(fp);
        files.push({ fp, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* ignore missing cache files */
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= NEURAL_TTS_MAX_CACHE_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= NEURAL_TTS_MAX_CACHE_BYTES * 0.8) break;
      try {
        await fs.promises.unlink(file.fp);
        total -= file.size;
      } catch {
        /* best-effort cache cleanup */
      }
    }
  })().finally(() => {
    neuralTtsCleanupPromise = null;
  });
  return neuralTtsCleanupPromise;
}

function enqueueNeuralTtsWork(work) {
  const run = neuralTtsQueue.catch(() => undefined).then(work);
  neuralTtsQueue = run.catch(() => undefined);
  return run;
}

async function fileExists(fp) {
  try {
    await fs.promises.access(fp, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePiperExecutable() {
  const envPath = String(process.env.PIPER_BINARY_PATH || "").trim();
  const candidates = [
    envPath,
    process.resourcesPath ? path.join(process.resourcesPath, "piper", process.platform === "win32" ? "piper.exe" : "piper") : "",
    path.join(__dirname, "piper", process.platform === "win32" ? "piper.exe" : "piper"),
    path.join(process.cwd(), "piper", process.platform === "win32" ? "piper.exe" : "piper"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "piper";
}

function runProcessCapture(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, timeoutMs, ...spawnOpts } = opts;
    const child = spawn(command, args, { windowsHide: process.platform === "win32", ...spawnOpts });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const timeout = Number(timeoutMs ?? 0);
    const timer =
      timeout > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill("SIGTERM");
            } catch {
              /* noop */
            }
            reject(new Error(`${path.basename(command)} timed out.`));
          }, timeout)
        : null;
    child.stdout?.on("data", (d) => stdoutChunks.push(d));
    child.stderr?.on("data", (d) => stderrChunks.push(d));
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}.`));
    });
    if (stdin != null) {
      child.stdin?.end(String(stdin));
    }
  });
}

async function hasPiperRuntime() {
  if (piperRuntimeProbePromise) return piperRuntimeProbePromise;
  piperRuntimeProbePromise = (async () => {
    const exe = await resolvePiperExecutable();
    await runProcessCapture(exe, ["--help"], { timeoutMs: 2500 });
    return true;
  })().catch(() => false);
  return piperRuntimeProbePromise;
}

async function requirePiperRuntime() {
  const exe = await resolvePiperExecutable();
  try {
    await runProcessCapture(exe, ["--help"], { timeoutMs: 2500 });
    return exe;
  } catch (err) {
    throw new Error(
      `Piper runtime is not available. Install Piper, add it to PATH, set PIPER_BINARY_PATH, or place the binary in the app's piper folder. ${err.message}`
    );
  }
}

async function listPiperVoicePacks({ requireRuntime = true } = {}) {
  if (requireRuntime && !(await hasPiperRuntime())) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(piperVoicePacksDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(piperVoicePacksDir(), entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    try {
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
      if (manifest?.engine !== "piper-vits") continue;
      const modelPath = path.join(dir, "model.onnx");
      const configPath = path.join(dir, "piper.onnx.json");
      if (!(await fileExists(modelPath)) || !(await fileExists(configPath))) continue;
      const packId = String(manifest.id || entry.name).replace(/[^a-zA-Z0-9._-]/g, "-");
      packs.push({
        id: `${PIPER_VOICE_ID_PREFIX}${packId}`,
        name: String(manifest.displayName || entry.name),
        language: String(manifest.language || "unknown"),
        gender: String(manifest.gender || "unknown"),
        accent: String(manifest.accent || "custom"),
        grade: "custom",
        engine: "piper-vits",
        model: modelPath,
        config: configPath,
        packDir: dir,
        recommendedSpeed:
          typeof manifest.recommendedSpeed === "number" && Number.isFinite(manifest.recommendedSpeed)
            ? manifest.recommendedSpeed
            : undefined,
      });
    } catch {
      /* ignore malformed packs */
    }
  }
  return packs;
}

async function synthesizePiperTts({ voiceId, text, speed, style, requestGeneration, prefetch }) {
  const packs = await listPiperVoicePacks({ requireRuntime: true });
  const pack = packs.find((v) => v.id === voiceId);
  if (!pack) throw new Error(`Piper voice pack not found. Put packs in ${piperVoicePacksDir()}.`);
  const dir = neuralTtsCacheDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const piperSpeed = Math.min(1.7, Math.max(0.45, speed));
  const lengthScale = Math.min(2.2, Math.max(0.45, 1 / piperSpeed));
  const key = neuralTtsCacheKey({ text, voice: voiceId, speed: piperSpeed, style, engine: "piper-vits", model: pack.model });
  const outPath = path.join(dir, `${key}.wav`);
  const inFlightKey = `${key}:${requestGeneration}`;
  try {
    const st = await fs.promises.stat(outPath);
    if (st.isFile() && st.size > 44) {
      return { ok: true, engine: "piper-vits", cached: true, path: outPath, url: pathToFileURL(outPath).toString(), durationMs: null };
    }
  } catch {
    /* synthesize below */
  }
  if (prefetch && neuralTtsInFlight.size > 0) {
    return { ok: false, skipped: true, reason: "busy" };
  }
  if (!neuralTtsInFlight.has(inFlightKey)) {
    neuralTtsInFlight.set(
      inFlightKey,
      enqueueNeuralTtsWork(async () => {
        if (requestGeneration !== neuralTtsGeneration) return { ok: false, canceled: true };
        const exe = await requirePiperRuntime();
        await runProcessCapture(
          exe,
          ["--model", pack.model, "--config", pack.config, "--length_scale", String(lengthScale), "--output_file", outPath],
          { stdin: `${text}\n`, timeoutMs: 60_000 }
        );
        if (requestGeneration !== neuralTtsGeneration) return { ok: false, canceled: true };
        void cleanupNeuralTtsCache();
        return { ok: true, engine: "piper-vits", cached: false, path: outPath, url: pathToFileURL(outPath).toString(), durationMs: null };
      }).finally(() => {
        neuralTtsInFlight.delete(inFlightKey);
      })
    );
  }
  return await neuralTtsInFlight.get(inFlightKey);
}

ipcMain.handle("iptv-neural-tts-voices", async () => {
  const piperVoices = await listPiperVoicePacks({ requireRuntime: false });
  return {
    ok: true,
    engine: piperVoices.length ? "piper-vits+kokoro-js" : "kokoro-js",
    model: KOKORO_MODEL_ID,
    modelCacheDir: neuralTtsModelCacheDir(),
    audioCacheDir: neuralTtsCacheDir(),
    piperVoicePacksDir: piperVoicePacksDir(),
    voices: [
      ...piperVoices.map(({ model, config, packDir, recommendedSpeed, ...voice }) => voice),
      ...KOKORO_VOICES.map((voice) => ({ ...voice, engine: "kokoro-js" })),
    ],
  };
});

ipcMain.handle("iptv-neural-tts-warmup", async () =>
  enqueueNeuralTtsWork(async () => {
    await loadKokoroTts();
    scheduleKokoroUnload(300_000);
    return { ok: true, engine: "kokoro-js", model: KOKORO_MODEL_ID };
  })
);

ipcMain.handle("iptv-neural-tts-cancel", async () => {
  neuralTtsGeneration += 1;
  scheduleKokoroUnload(45_000);
  return { ok: true };
});

ipcMain.handle("iptv-neural-tts-synthesize", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const text = normalizeNeuralTtsText(p.text);
  if (!text) throw new Error("No text to synthesize.");
  const rawVoice = typeof p.voice === "string" ? p.voice : "";
  const speedRaw = Number(p.speed);
  const speed = Number.isFinite(speedRaw) ? Math.min(1.35, Math.max(0.65, speedRaw)) : 1;
  const style = typeof p.style === "string" ? p.style.slice(0, 40) : "warm";
  const prefetch = p.prefetch === true;
  const requestGeneration = neuralTtsGeneration;
  if (rawVoice.startsWith(PIPER_VOICE_ID_PREFIX)) {
    return await synthesizePiperTts({ voiceId: rawVoice, text, speed, style, requestGeneration, prefetch });
  }
  const voice = KOKORO_VOICE_IDS.has(rawVoice) ? rawVoice : "af_heart";
  const dir = neuralTtsCacheDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const key = neuralTtsCacheKey({ text, voice, speed, style });
  const outPath = path.join(dir, `${key}.wav`);
  const inFlightKey = `${key}:${requestGeneration}`;
  try {
    const st = await fs.promises.stat(outPath);
    if (st.isFile() && st.size > 44) {
      return { ok: true, engine: "kokoro-js", cached: true, path: outPath, url: pathToFileURL(outPath).toString(), durationMs: null };
    }
  } catch {
    /* synthesize below */
  }
  if (prefetch && neuralTtsInFlight.size > 0) {
    return { ok: false, skipped: true, reason: "busy" };
  }
  if (!neuralTtsInFlight.has(inFlightKey)) {
    neuralTtsInFlight.set(
      inFlightKey,
      enqueueNeuralTtsWork(async () => {
        if (requestGeneration !== neuralTtsGeneration) {
          return { ok: false, canceled: true };
        }
        const tts = await loadKokoroTts();
        const audio = await tts.generate(text, { voice, speed });
        if (requestGeneration !== neuralTtsGeneration) {
          return { ok: false, canceled: true };
        }
        await audio.save(outPath);
        void cleanupNeuralTtsCache();
        scheduleKokoroUnload();
        const samples = Number(audio.audio?.length ?? 0);
        const sampleRate = Number(audio.sampling_rate ?? 0);
        const durationMs = samples > 0 && sampleRate > 0 ? Math.round((samples / sampleRate) * 1000) : null;
        return {
          ok: true,
          engine: "kokoro-js",
          cached: false,
          path: outPath,
          url: pathToFileURL(outPath).toString(),
          durationMs,
        };
      }).finally(() => {
        neuralTtsInFlight.delete(inFlightKey);
      })
    );
  }
  return await neuralTtsInFlight.get(inFlightKey);
});

/** Desktop: local Whisper model status for live radio captions. */
ipcMain.handle("iptv-whisper-status", async () => whisperStt.getWhisperStatus());

/** Desktop: load Whisper ONNX model (downloads on first run). */
ipcMain.handle("iptv-whisper-warmup", async () => whisperStt.warmupWhisper());

/** Desktop: transcribe Float32 PCM mono @ 16 kHz (low-latency live captions). */
ipcMain.handle("iptv-whisper-transcribe-pcm", async (_evt, rawBuf) => {
  if (!rawBuf) return { ok: false, error: "No audio data." };
  if (rawBuf instanceof ArrayBuffer) return whisperStt.transcribePcmFloat32(rawBuf);
  if (ArrayBuffer.isView(rawBuf)) {
    return whisperStt.transcribePcmFloat32(
      rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength)
    );
  }
  return { ok: false, error: "Invalid PCM buffer." };
});

/** Desktop: transcribe one WebM/OGG chunk (legacy MediaRecorder path). */
ipcMain.handle("iptv-whisper-transcribe-chunk", async (_evt, rawBuf) => {
  if (!rawBuf) return { ok: false, error: "No audio data." };
  let buf = rawBuf;
  if (ArrayBuffer.isView(rawBuf)) {
    buf = Buffer.from(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
  } else if (rawBuf instanceof ArrayBuffer) {
    buf = Buffer.from(rawBuf);
  } else if (!Buffer.isBuffer(rawBuf)) {
    return { ok: false, error: "Invalid audio buffer." };
  }
  return whisperStt.transcribeWebmChunk(buf);
});

/** Reveal the recorded file in Finder / File Explorer / file manager. */
ipcMain.handle("iptv-show-record-in-folder", async (_evt, rawPath) => {
  const resolved = assertAllowedRecordRevealPath(rawPath);
  shell.showItemInFolder(resolved);
  return { ok: true };
});

app.on("before-quit", () => {
  for (const id of [...streamRecordings.keys()]) {
    teardownRecording(id, true);
  }
  for (const s of staticServers) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  staticServers = [];
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
  return assertSafeFetchUrl(raw, "target URL");
}

async function waitForMkvHlsFile(filePath, child, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null && child.exitCode !== 0) {
      throw new Error(`ffmpeg exited ${child.exitCode} while preparing playback.`);
    }
    try {
      const st = await fs.promises.stat(filePath);
      if (st.size > 0) return st;
      if (child && child.exitCode === 0) return st;
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
    await sleepMs(180);
  }
  throw new Error("Timed out waiting for remuxed video data.");
}

async function tryServeMkvPlayback(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }

  const mHls = u.pathname.match(/^\/__mkv-playback\/([a-f0-9]{48})\/(index\.m3u8|seg\d+\.ts)$/i);
  const mMp4 = u.pathname.match(/^\/__mkv-playback\/([a-f0-9]{48})\.mp4$/i);
  const cacheKey = mHls?.[1] ?? mMp4?.[1];
  if (!cacheKey) return false;

  try {
    assertStreamProxySessionToken(req.url || "/");
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Forbidden");
    return true;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Range",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed");
    return true;
  }

  let filePath = null;
  let contentType = "application/octet-stream";
  if (mHls) {
    filePath = mkvHlsFilePath(cacheKey, mHls[2]);
    contentType = mHls[2].toLowerCase().endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t";
  } else {
    filePath = mkvCacheFilePath(cacheKey);
    contentType = "video/mp4";
  }
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return true;
  }

  const session = mkvPlaybackSessions.get(cacheKey);
  const child = session?.child ?? null;

  let st;
  try {
    st = await waitForMkvHlsFile(filePath, child, mHls ? 90_000 : 45_000);
  } catch (e) {
    res
      .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
      .end(e instanceof Error ? e.message : "MKV playback not ready");
    return true;
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Content-Length": String(st.size),
  };

  if (req.method === "HEAD") {
    res.writeHead(200, headers).end();
    return true;
  }

  if (mHls && mHls[2].toLowerCase() === "index.m3u8") {
    try {
      let text = await fs.promises.readFile(filePath, "utf8");
      const token = u.searchParams.get("token") || streamProxySessionToken || "";
      const base = `${u.protocol}//${u.host}/__mkv-playback/${cacheKey}/`;
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      text = text
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!/^seg\d+\.ts$/i.test(t)) return line;
          return `${base}${t}${qs}`;
        })
        .join("\n");
      const body = Buffer.from(text, "utf8");
      headers["Content-Length"] = String(body.length);
      res.writeHead(200, headers).end(body);
      return true;
    } catch (e) {
      res
        .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
        .end(e instanceof Error ? e.message : "MKV playlist not ready");
      return true;
    }
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  });
  stream.pipe(res);
  return true;
}

async function tryServeStreamProxy(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (u.pathname !== "/__proxy/stream") return false;

  try {
    assertStreamProxySessionToken(req.url || "/");
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Forbidden");
    return true;
  }

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

  try {
    assertStreamProxySessionToken(req.url || "/");
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Forbidden");
    return true;
  }

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
  if (pathname === "/__proxy/stream" || pathname === "/__tap/stream" || pathname.startsWith("/__mkv-playback/")) {
    return null;
  }
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
/** Max offset for the second static server on the same primary attempt. */
const STATIC_SERVER_SECOND_PORT_SPAN = 96;

function iptvReservedPortEnd() {
  return STATIC_SERVER_PREFERRED_PORT + STATIC_SERVER_PORT_TRIES - 1 + STATIC_SERVER_SECOND_PORT_SPAN;
}

function isTcpPortListening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = nodeNet.connect({ port, host });
    const done = (listening) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      resolve(listening);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function killListenersOnPort(port) {
  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (/^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        if (pid === String(process.pid)) continue;
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        } catch {
          /* noop */
        }
      }
    } catch {
      /* no listener */
    }
    return;
  }
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      if (pid === String(process.pid)) continue;
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          /* noop */
        }
      }
    }
  } catch {
    /* no listener */
  }
}

/** Stop stale listeners in the IPTV port range (e.g. crashed Electron still holding 48752). */
async function releaseIptvPortsBeforeStart() {
  const start = STATIC_SERVER_PREFERRED_PORT;
  const end = iptvReservedPortEnd();
  const busy = [];
  for (let port = start; port <= end; port++) {
    if (await isTcpPortListening(port)) busy.push(port);
  }
  if (!busy.length) return;
  console.warn(
    `IPTV: freeing ${busy.length} reserved port(s) still listening: ${busy.slice(0, 6).join(", ")}${busy.length > 6 ? "…" : ""}`
  );
  for (const port of busy) {
    killListenersOnPort(port);
  }
  await new Promise((r) => setTimeout(r, 250));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await isTcpPortListening(STATIC_SERVER_PREFERRED_PORT))) return;
    killListenersOnPort(STATIC_SERVER_PREFERRED_PORT);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function createStaticRequestHandler(root) {
  return (req, res) => {
    void (async () => {
      try {
        if (await tryServeStreamTap(req, res)) return;
        if (await tryServeMkvPlayback(req, res)) return;
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
        if (ext === ".html") {
          res.setHeader("Content-Security-Policy", APP_CSP);
        }
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
    await releaseIptvPortsBeforeStart();
    streamProxySessionToken = crypto.randomBytes(32).toString("hex");
    for (let i = 0; i < STATIC_SERVER_PORT_TRIES; i++) {
      const port1 = STATIC_SERVER_PREFERRED_PORT + i;
      try {
        const first = await listenOnPort(port1);
        let second = null;
        for (let k = 1; k <= STATIC_SERVER_SECOND_PORT_SPAN; k++) {
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
  const preferenceMenu = {
    label: "Preferences",
    submenu: [
      {
        id: "split-screen-preference",
        label: "Enable split screen",
        type: "checkbox",
        checked: splitScreenPreferenceEnabled,
        click: (item) => {
          splitScreenPreferenceEnabled = !!item.checked;
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
          win?.webContents.send("iptv-split-screen-preference-change", splitScreenPreferenceEnabled);
        },
      },
    ],
  };
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
          { label: "File", submenu: [preferenceMenu, { type: "separator" }, { role: "close" }] },
        ]
      : [{ label: "File", submenu: [preferenceMenu, { type: "separator" }, { role: "quit", label: "Exit" }] }]),
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
      "Player",
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
    title: "Player",
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        void shell.openExternal(u.toString());
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    try {
      if (rendererOrigin && new URL(url).origin !== rendererOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

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

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const win = windows[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (app.isReady()) {
      void createWindow();
    }
  });

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
}
