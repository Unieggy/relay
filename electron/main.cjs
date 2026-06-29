/**
 * Relay desktop companion (Electron).
 *
 * Wraps the rail-only UI (?rail=1) in a narrow, always-on-top window docked to a
 * screen edge — the "magnet" terminal companion. Reuses the exact same React UI;
 * no rewrite. Also exposes a native folder picker the browser can't provide.
 *
 *   npm run desktop              # starts the full demo stack + this app
 *   npm run desktop:real         # uses authenticated Claude/Codex CLIs
 *   npm run desktop:shell        # shell only, when the stack already runs
 *   RELAY_DOCK=left npm run desktop
 *   RELAY_DOCK=float npm run desktop
 */

const { app, BrowserWindow, screen, ipcMain, dialog } = require("electron");
const path = require("node:path");

const UI = process.env.RELAY_UI || "http://127.0.0.1:4173";
const API = process.env.RELAY_API || "http://127.0.0.1:4000";
const WS = process.env.RELAY_WS || "ws://127.0.0.1:4000";
const DOCK = process.env.RELAY_DOCK || "right"; // right | left | float
// Rail-only (compact companion) by default. RELAY_RAIL=0 loads the full
// dashboard (terminal + chat box) inside Electron.
const RAIL = process.env.RELAY_RAIL !== "0";
const WIDTH = Number(process.env.RELAY_WIDTH || (RAIL ? 400 : 1200));

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
    title: "Baton",
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Normal window by default so it alt-tabs and never blocks other apps.
  // Opt in to a floating companion with RELAY_ONTOP=1.
  if (process.env.RELAY_ONTOP === "1") win.setAlwaysOnTop(true, "floating");
  place(win);

  const railParam = RAIL ? "rail=1&" : "";
  const url = `${UI}/?${railParam}api=${encodeURIComponent(API)}&ws=${encodeURIComponent(WS)}`;
  void win.loadURL(url);

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
