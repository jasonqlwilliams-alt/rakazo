import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { desktopCookieHeader, imageMimeType, parsePickedFiles } from "./file-picker.js";
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
  ipcMain.handle("desktop.file.pick", async (event, input: unknown) => {
    const botId =
      input && typeof input === "object" && "botId" in input
        ? String((input as { botId: unknown }).botId)
        : "";
    if (!botId) throw new Error("Choose an active bot before attaching photos");
    const win = windowFrom(event);
    const options = {
      title: "Add photos to Rakazo",
      properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
      filters: [
        {
          name: "Images",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "tif",
            "tiff",
            "heic",
            "heif",
            "avif",
          ],
        },
      ],
    };
    const selection = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || selection.filePaths.length === 0) return [];
    if (selection.filePaths.length > 12) throw new Error("Choose no more than 12 images at once");

    const form = new FormData();
    form.set("botId", botId);
    let total = 0;
    for (const filePath of selection.filePaths) {
      const mimeType = imageMimeType(filePath);
      if (!mimeType) throw new Error(`${path.basename(filePath)} is not a supported image`);
      const info = await stat(filePath);
      if (info.size > 25 * 1024 * 1024) {
        throw new Error(`${path.basename(filePath)} is larger than 25 MB`);
      }
      total += info.size;
      if (total > 100 * 1024 * 1024) {
        throw new Error("The selected images are larger than 100 MB together");
      }
      form.append(
        "files",
        new Blob([new Uint8Array(await readFile(filePath))], { type: mimeType }),
        path.basename(filePath),
      );
    }

    const cookies = await event.sender.session.cookies.get({ url: WEB_URL });
    const response = await fetch(new URL("/api/desktop-files", WEB_URL), {
      method: "POST",
      headers: {
        cookie: desktopCookieHeader(cookies),
        origin: new URL(WEB_URL).origin,
      },
      body: form,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : "Could not attach photos";
      throw new Error(message);
    }
    return parsePickedFiles(payload);
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
