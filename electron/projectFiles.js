import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { promises as fs } from "fs";
import path from "path";

async function readProjectFile(filePath) {
  const bytes = await fs.readFile(filePath);
  app.addRecentDocument(filePath);
  return {
    path: filePath,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

export function registerProjectFileHandlers() {
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
}
