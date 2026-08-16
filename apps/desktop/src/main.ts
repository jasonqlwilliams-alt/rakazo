import { existsSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { browserWindowOptions } from "./window-options.js";

const WEB_URL = process.env.RAKAZO_WEB_URL ?? "http://127.0.0.1:5173";

function windowFrom(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

// Shown instead of a black window when the local stack is not up yet. A packaged
// file rather than a data: URL, because Chromium blocks top-level data:
// navigation and the load silently does nothing.
function showWaitingPage(win: BrowserWindow, reason: string) {
  // The title is set first and independently: it is the one signal that survives
  // even if the page itself will not load, so the window is never anonymously black.
  win.setTitle("Rakazo — waiting for the stack");
  return win.loadFile(path.join(import.meta.dirname, "waiting.html"), {
    query: { url: WEB_URL, reason },
  });
}

function createWindow() {
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...browserWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // A single loadURL leaves a black window whenever the stack is down, with no
  // way to tell "not started" from "broken". Say so, and keep retrying.
  let retrying = false;
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (win.isDestroyed()) return;
      // Sub-frame loads and aborted (-3) navigations are not the page failing to
      // open. Do not compare the URL here: Chromium normalises it, so an origin
      // without a trailing slash never matches what it reports back.
      if (retrying || !isMainFrame || errorCode === -3) return;
      retrying = true;
      void showWaitingPage(win, `${errorDescription} (${errorCode})`).catch(() => undefined);
      const timer = setInterval(() => {
        if (win.isDestroyed()) {
          clearInterval(timer);
          return;
        }
        void win
          .loadURL(WEB_URL)
          .then(() => {
            clearInterval(timer);
            retrying = false;
          })
          .catch(() => undefined);
      }, 3000);
    },
  );

  void win.loadURL(WEB_URL).catch(() => undefined);
}

app.whenReady().then(() => {
  const icon = developmentIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  ipcMain.handle("desktop.platform", () => process.platform);
  ipcMain.handle("desktop.window.close", (event) => {
    windowFrom(event)?.close();
  });
  ipcMain.handle("desktop.window.minimize", (event) => {
    windowFrom(event)?.minimize();
  });
  ipcMain.handle("desktop.window.toggleMaximize", (event) => {
    const win = windowFrom(event);
    if (!win) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle("desktop.window.state", (event) => {
    const win = windowFrom(event);
    return {
      minimized: win?.isMinimized() ?? false,
      maximized: win?.isMaximized() ?? false,
      fullScreen: win?.isFullScreen() ?? false,
    };
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
