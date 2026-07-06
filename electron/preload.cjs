const { contextBridge, ipcRenderer } = require("electron");

function onMenuCommand(channel, callback) {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("minipaint", {
  onExportPng(callback) {
    return onMenuCommand("menu:export-png", callback);
  },
  onSaveProject(callback) {
    return onMenuCommand("menu:save-project", callback);
  },
  onOpenProject(callback) {
    return onMenuCommand("menu:open-project", callback);
  },
  onShowGallery(callback) {
    return onMenuCommand("menu:show-gallery", callback);
  },
  saveProjectFile(bytes, path) {
    return ipcRenderer.invoke("project:save", bytes, path);
  },
  openProjectFile() {
    return ipcRenderer.invoke("project:open");
  },
  openRecentProjectFile(path) {
    return ipcRenderer.invoke("project:open-recent", path);
  },
});
