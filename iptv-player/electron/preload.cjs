const { contextBridge, ipcRenderer } = require("electron");



contextBridge.exposeInMainWorld("iptv", {

  /** Fetches playlist text in the main process (no browser CORS). */

  fetchPlaylistText: (url) => ipcRenderer.invoke("iptv-fetch-playlist-text", url),

  /** Two localhost origins (different ports) so split-view players do not share one HTTP/1.1 connection pool. */
  getStreamProxyOrigins: () => ipcRenderer.invoke("iptv-get-stream-proxy-origins"),

  pickRecordDir: () => ipcRenderer.invoke("iptv-pick-record-dir"),

  /** Desktop: native open dialog + main-process readFile; returns rows for IndexedDB. */
  pickLocalAudioFiles: () => ipcRenderer.invoke("iptv-pick-local-audio-files"),

  startStreamRecord: (payload) => ipcRenderer.invoke("iptv-start-stream-record", payload),

  stopStreamRecord: (id) => ipcRenderer.invoke("iptv-stop-stream-record", id),

  /** Desktop: reveal the saved recording in File Explorer. */
  showRecordInFolder: (filePath) => ipcRenderer.invoke("iptv-show-record-in-folder", filePath),

});

