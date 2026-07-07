import { app, BrowserWindow, Menu } from "electron";

const isMac = process.platform === "darwin";

function getTargetWindow(win) {
  return BrowserWindow.getFocusedWindow() ?? win;
}

function sendMenuCommand(win, channel) {
  getTargetWindow(win)?.webContents.send(channel);
}

export function createApplicationMenu(win) {
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
          click: () => sendMenuCommand(win, "menu:show-gallery"),
        },
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => sendMenuCommand(win, "menu:open-project"),
        },
        {
          label: "Save Project…",
          accelerator: "CmdOrCtrl+S",
          click: () => sendMenuCommand(win, "menu:save-project"),
        },
        { type: "separator" },
        {
          label: "Export",
          submenu: [
            {
              label: "Export as PNG",
              accelerator: "CmdOrCtrl+Shift+E",
              click: () => sendMenuCommand(win, "menu:export-png"),
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
