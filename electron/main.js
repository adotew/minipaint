import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";

function getTargetWindow(win) {
  return BrowserWindow.getFocusedWindow() ?? win;
}

function sendExportPngCommand(win) {
  getTargetWindow(win)?.webContents.send("menu:export-png");
}

function sendSaveProjectCommand(win) {
  getTargetWindow(win)?.webContents.send("menu:save-project");
}

function sendOpenProjectCommand(win) {
  getTargetWindow(win)?.webContents.send("menu:open-project");
}

function sendShowGalleryCommand(win) {
  getTargetWindow(win)?.webContents.send("menu:show-gallery");
}

function createApplicationMenu(win) {
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
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Gallery",
          accelerator: "CmdOrCtrl+G",
          click: () => sendShowGalleryCommand(win),
        },
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => sendOpenProjectCommand(win),
        },
        {
          label: "Save Project…",
          accelerator: "CmdOrCtrl+S",
          click: () => sendSaveProjectCommand(win),
        },
        { type: "separator" },
        {
          label: "Export",
          submenu: [
            {
              label: "Export as PNG",
              accelerator: "CmdOrCtrl+Shift+E",
              click: () => sendExportPngCommand(win),
            },
          ],
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }, { type: "separator" }, { role: "window" }]
          : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("project:save", async (event, bytes, existingPath) => {
  let filePath = typeof existingPath === "string" && existingPath.length > 0
    ? existingPath
    : null;

  if (!filePath) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win ?? undefined, {
      title: "Save Project",
      defaultPath: "Untitled.minipaint",
      filters: [{ name: "minipaint Project", extensions: ["minipaint"] }],
    });

    if (result.canceled || !result.filePath) return null;
    filePath = result.filePath.endsWith(".minipaint")
      ? result.filePath
      : `${result.filePath}.minipaint`;
  }

  await fs.writeFile(filePath, Buffer.from(bytes));
  app.addRecentDocument(filePath);
  return filePath;
});

async function readProjectFile(filePath) {
  const bytes = await fs.readFile(filePath);
  app.addRecentDocument(filePath);
  return {
    path: filePath,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

ipcMain.handle("project:open", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: "Open Project",
    properties: ["openFile"],
    filters: [{ name: "minipaint Project", extensions: ["minipaint"] }],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  return await readProjectFile(result.filePaths[0]);
});

ipcMain.handle("project:open-recent", async (_event, filePath) => {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  return await readProjectFile(filePath);
});

ipcMain.handle("project:rename", async (_event, oldPath, newName) => {
  if (typeof oldPath !== "string" || typeof newName !== "string") return null;

  let base = newName.trim().replace(/[\\/]/g, "_");
  if (!base) return null;
  if (!base.toLowerCase().endsWith(".minipaint")) base += ".minipaint";

  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, base);
  if (newPath === oldPath) return oldPath;

  try {
    await fs.access(newPath);
    throw new Error("A file with that name already exists.");
  } catch (err) {
    if (err instanceof Error && err.message === "A file with that name already exists.") throw err;
  }

  await fs.rename(oldPath, newPath);
  app.addRecentDocument(newPath);
  return newPath;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "minipaint",
    // Native title bar on all platforms
    titleBarStyle: "default",
    backgroundColor: "#00000000",
    webPreferences: {
      // No node integration — the renderer stays a pure browser context
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  createApplicationMenu(win);

  // In development, Vite runs on port 1420
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
