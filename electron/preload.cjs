const { contextBridge, ipcRenderer } = require("electron");



contextBridge.exposeInMainWorld("iptv", {

  /** Fetches playlist text in the main process (no browser CORS). */

  fetchPlaylistText: (url) => ipcRenderer.invoke("iptv-fetch-playlist-text", url),

  /** Desktop: YouTube web search in main; returns first video id and its listing title (for lyrics + open in browser). */
  youtubeFirstVideoIdFromSearch: (query) => ipcRenderer.invoke("iptv-youtube-first-video-id", query),

  /** Desktop: GET JSON from an allow-listed https host (LRCLIB, MyMemory) for lyrics / translation. */
  httpGetJson: (url) => ipcRenderer.invoke("iptv-http-get-json", url),

  /** Desktop: album art via iTunes Search + mzstatic CDN when tags have no embedded cover. */
  fetchAlbumArtOnline: (payload) => ipcRenderer.invoke("iptv-fetch-album-art-online", payload),

  /** Desktop: POST LibreTranslate (public instances) for lyric translation (no CORS). */
  libreTranslate: (payload) => ipcRenderer.invoke("iptv-libre-translate", payload),

  /** Desktop: GET Google Translate web-style batch (client=gtx); small `q` only; no API key. */
  googleTranslateGtx: (payload) => ipcRenderer.invoke("iptv-google-translate-gtx", payload),

  /** Desktop: `{ hasKey, apiBasePreview, modelPreview }` for OpenAI-compatible lyric LLM (never returns the key). */
  getLyricsChatTranslateKeyStatus: () => ipcRenderer.invoke("iptv-lyrics-chat-translate-key-status"),

  /** Desktop: save or clear LLM credentials (`{ key, baseUrl?, model? }`; empty key clears all saved fields). */
  setLyricsChatTranslateCredentials: (payload) =>
    ipcRenderer.invoke("iptv-lyrics-chat-translate-save-credentials", payload),

  /** Desktop: POST `/v1/chat/completions` (DeepSeek, OpenAI, OpenRouter); returns `{ translatedText }`; `IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY` if unset. */
  lyricsChatTranslate: (payload) => ipcRenderer.invoke("iptv-lyrics-chat-translate", payload),

  /** Desktop: one LLM JSON response — find lyrics + English in one step (same key as lyricsChatTranslate). */
  lyricsLlmUnifiedFetch: (payload) => ipcRenderer.invoke("iptv-lyrics-llm-unified-fetch", payload),

  /** Desktop: Gemini JSON response — find lyrics + English + song meaning in one step. */
  lyricsGeminiUnifiedFetch: (payload) => ipcRenderer.invoke("iptv-lyrics-gemini-unified-fetch", payload),

  /** Desktop: LLM explanation of what a song is about (artist/title from file tags). */
  lyricsSongMeaningFetch: (payload) => ipcRenderer.invoke("iptv-lyrics-song-meaning-fetch", payload),

  /** Two localhost origins (different ports) so split-view players do not share one HTTP/1.1 connection pool. */
  getStreamProxyOrigins: () => ipcRenderer.invoke("iptv-get-stream-proxy-origins"),

  /** Desktop menu preference: File > Preferences > Enable split screen. */
  setSplitScreenPreference: (enabled) => ipcRenderer.invoke("iptv-set-split-screen-preference", enabled),

  onSplitScreenPreferenceChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, enabled) => callback(!!enabled);
    ipcRenderer.on("iptv-split-screen-preference-change", handler);
    return () => ipcRenderer.removeListener("iptv-split-screen-preference-change", handler);
  },

  pickRecordDir: () => ipcRenderer.invoke("iptv-pick-record-dir"),

  /** Desktop: native open dialog + main-process readFile; returns rows for IndexedDB. */
  pickLocalAudioFiles: () => ipcRenderer.invoke("iptv-pick-local-audio-files"),

  /** Desktop: native open dialog; returns `{ id, name, url }[]` with `file://` playback URLs. */
  pickLocalVideoFiles: () => ipcRenderer.invoke("iptv-pick-local-video-files"),

  /** Desktop: remux or transcode Matroska to H.264/AAC MP4 for Chromium playback; returns `playUrl` (often `file://` temp). */
  prepareMkvPlayback: (fileUrl) => ipcRenderer.invoke("iptv-prepare-mkv-playback", fileUrl),

  startStreamRecord: (payload) => ipcRenderer.invoke("iptv-start-stream-record", payload),

  stopStreamRecord: (id) => ipcRenderer.invoke("iptv-stop-stream-record", id),

  /** Desktop: local neural TTS voices and synthesis (Piper packs when installed, Kokoro built in). */
  listNeuralTtsVoices: () => ipcRenderer.invoke("iptv-neural-tts-voices"),

  warmupNeuralTts: () => ipcRenderer.invoke("iptv-neural-tts-warmup"),

  synthesizeNeuralTts: (payload) => ipcRenderer.invoke("iptv-neural-tts-synthesize", payload),

  cancelNeuralTts: () => ipcRenderer.invoke("iptv-neural-tts-cancel"),

  /** Desktop: local Whisper STT for live radio captions. */
  whisperStatus: () => ipcRenderer.invoke("iptv-whisper-status"),

  whisperWarmup: () => ipcRenderer.invoke("iptv-whisper-warmup"),

  whisperTranscribePcm: (pcmArrayBuffer) => ipcRenderer.invoke("iptv-whisper-transcribe-pcm", pcmArrayBuffer),

  whisperTranscribeChunk: (audioWebm) => ipcRenderer.invoke("iptv-whisper-transcribe-chunk", audioWebm),

  /** Desktop: reveal the saved recording in File Explorer. */
  showRecordInFolder: (filePath) => ipcRenderer.invoke("iptv-show-record-in-folder", filePath),

});

