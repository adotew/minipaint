const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("minipaint", {
  onExportPng(callback) {
    const listener = () => callback();
    ipcRenderer.on("menu:export-png", listener);
    return () => ipcRenderer.removeListener("menu:export-png", listener);
  },
});
