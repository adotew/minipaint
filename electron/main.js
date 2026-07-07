import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "url";
import path from "path";
import { createApplicationMenu } from "./menu.js";
import { registerProjectFileHandlers } from "./projectFiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
