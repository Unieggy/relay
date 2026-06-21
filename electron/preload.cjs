/**
 * Relay desktop preload — a tiny, safe bridge.
 * Exposes only a native folder picker to the web UI; nothing else.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relay", {
  /** Open the OS folder dialog; resolves to an absolute path or null. */
  pickWorkspace: () => ipcRenderer.invoke("relay:pick-workspace"),
});
