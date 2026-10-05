const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { ConfigStore, normalizeServer, normalizeSubscription } = require("./config-store");

let mainWindow;
let configStore;

function validateHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Subscription URL is invalid.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
    throw new Error("Subscription URL must be HTTP or HTTPS and must not include login credentials.");
  }
  return url;
}

function fetchSubscriptionText(value, redirects) {
  const redirectCount = redirects || 0;
  let url;
  try {
    url = validateHttpUrl(value);
  } catch (error) {
    return Promise.reject(error);
  }
  if (redirectCount > 4) return Promise.reject(new Error("Subscription URL redirected too many times."));

  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: {
        "User-Agent": "Choobs/0.1.0",
        "Accept-Encoding": "identity"
      },
      timeout: 15000
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        let redirectUrl;
        try {
          redirectUrl = new URL(response.headers.location, url);
        } catch (error) {
          reject(new Error("Subscription server returned an invalid redirect."));
          return;
        }
        if (url.protocol === "https:" && redirectUrl.protocol !== "https:") {
          reject(new Error("Subscription redirect cannot downgrade HTTPS to HTTP."));
          return;
        }
        fetchSubscriptionText(redirectUrl.href, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Subscription server returned HTTP ${status}.`));
        return;
      }

      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          response.destroy(new Error("Subscription response is larger than 5 MB."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Subscription request timed out.")));
    request.on("error", reject);
  });
}

function pingServer(server) {
  if (!server || typeof server.address !== "string" || !server.address.trim()
      || !Number.isInteger(Number(server.port)) || Number(server.port) < 1 || Number(server.port) > 65535) {
    return Promise.reject(new Error("Server address or port is invalid."));
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.createConnection({
      host: server.address,
      port: Number(server.port)
    });
    socket.setTimeout(3000);
    socket.once("connect", () => {
      const ping = Date.now() - startedAt;
      socket.destroy();
      resolve({ ping });
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Connection timed out."));
    });
    socket.once("error", reject);
  });
}

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
  ipcMain.handle("choobs:fetch-subscription", (_event, url) => fetchSubscriptionText(url));
  ipcMain.handle("choobs:ping-server", (_event, server) => pingServer(server));
  ipcMain.handle("choobs:export-servers", async (_event, data) => {
    const payload = Array.isArray(data) ? { servers: data, subscriptions: [] } : data;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.servers)) {
      throw new Error("Export data must contain a server list.");
    }

    const normalizedServers = payload.servers.map(normalizeServer);
    const normalizedSubscriptions = Array.isArray(payload.subscriptions)
      ? payload.subscriptions.map(normalizeSubscription)
      : [];
    if (!normalizedServers.every(Boolean) || !normalizedSubscriptions.every(Boolean)) {
      throw new Error("The export contains invalid server or subscription data.");
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export servers",
      defaultPath: "choobs-servers.json",
      filters: [{ name: "JSON files", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) return false;

    fs.writeFileSync(result.filePath, `${JSON.stringify({
      format: "choobs-config",
      version: 1,
      subscriptions: normalizedSubscriptions,
      servers: normalizedServers,
      selectedServerId: typeof payload.selectedServerId === "string" ? payload.selectedServerId : null,
      settings: payload.settings && typeof payload.settings === "object" ? payload.settings : {}
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
