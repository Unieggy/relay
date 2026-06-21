/**
 * Relay desktop companion (Electron).
 *
 * Wraps the rail-only UI (?rail=1) in a narrow, always-on-top window docked to a
 * screen edge — the "magnet" terminal companion. Reuses the exact same React UI;
 * no rewrite. Also exposes a native folder picker the browser can't provide.
 *
 *   npm run demo                 # server + UI in one shell
 *   npm run desktop              # this app in another (docks right)
 *   RELAY_DOCK=left npm run desktop
 *   RELAY_DOCK=float npm run desktop
 */

const { app, BrowserWindow, screen, ipcMain, dialog } = require("electron");
const path = require("node:path");

const UI = process.env.RELAY_UI || "http://127.0.0.1:4173";
const API = process.env.RELAY_API || "http://127.0.0.1:4000";
const WS = process.env.RELAY_WS || "ws://127.0.0.1:4000";
const DOCK = process.env.RELAY_DOCK || "right"; // right | left | float
const WIDTH = Number(process.env.RELAY_WIDTH || 400);

function place(win) {
  const { workArea } = screen.getPrimaryDisplay();
  if (DOCK === "float") {
    win.setBounds({ x: workArea.x + 40, y: workArea.y + 40, width: WIDTH, height: 760 });
    return;
  }
  const x = DOCK === "left" ? workArea.x : workArea.x + workArea.width - WIDTH;
  win.setBounds({ x, y: workArea.y, width: WIDTH, height: workArea.height });
}

function createWindow() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: 760,
    minWidth: 320,
    title: "Relay",
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  win.setAlwaysOnTop(true, "floating");
  place(win);

  const url = `${UI}/?rail=1&api=${encodeURIComponent(API)}&ws=${encodeURIComponent(WS)}`;
  win.loadURL(url);

  // Re-snap to the edge if the screen layout changes.
  screen.on("display-metrics-changed", () => place(win));
  return win;
}

// Native folder picker — returned to the renderer via the preload bridge.
ipcMain.handle("relay:pick-workspace", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a workspace",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
