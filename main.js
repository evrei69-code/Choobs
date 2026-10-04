const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { ConfigStore, normalizeServer } = require("./config-store");

let mainWindow;
let configStore;

function registerIpcHandlers() {
  ipcMain.handle("choobs:load-config", () => configStore.load());
  ipcMain.handle("choobs:save-config", (_event, config) => configStore.save(config));
  ipcMain.handle("choobs:import-servers", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import servers",
      properties: ["openFile"],
      filters: [{ name: "JSON files", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    const stats = fs.statSync(filePath);
    if (stats.size > 5 * 1024 * 1024) throw new Error("The selected file is larger than 5 MB.");

    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("This file is not valid JSON.");
      throw error;
    }
  });
  ipcMain.handle("choobs:export-servers", async (_event, servers) => {
    if (!Array.isArray(servers) || servers.length === 0) {
      throw new Error("At least one server is required for export.");
    }

    const normalizedServers = servers.map(normalizeServer);
    if (!normalizedServers.every(Boolean)) throw new Error("The server list contains invalid data.");

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export servers",
      defaultPath: "choobs-servers.json",
      filters: [{ name: "JSON files", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) return false;

    fs.writeFileSync(result.filePath, `${JSON.stringify({
      format: "choobs-servers",
      version: 1,
      servers: normalizedServers
    }, null, 2)}\n`, "utf8");
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#111315",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "app", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  configStore = new ConfigStore(path.join(app.getPath("userData"), "choobs-config.json"));
  registerIpcHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
