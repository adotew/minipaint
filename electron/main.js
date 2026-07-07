import { app, BrowserWindow, Menu } from "electron";
import { fileURLToPath } from "url";
import path from "path";
import { registerProjectFileHandlers } from "./projectFiles.js";

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

registerProjectFileHandlers();

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
