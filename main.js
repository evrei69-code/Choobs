const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const readline = require("readline");
const { TextDecoder } = require("util");
const zlib = require("zlib");
const { ConfigStore, normalizeServer, normalizeSubscription } = require("./config-store");

const iconDirectory = path.join(__dirname, "assets", "icons");
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow;
let configStore;
let coreManagerProcess = null;
let coreManagerPending = null;
let coreManagerRequestId = 0;
let coreManagerQueue = Promise.resolve();
let tray = null;
let trayStatus = { running: false, state: "stopped" };
let trayActionPending = false;
let exitRequested = false;

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

function safeContentType(value) {
  const contentType = String(value || "");
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) return "unknown";
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  if (!charset) return mimeType;
  const supportedCharsets = new Set([
    "utf8", "utf-8", "utf-16", "utf-16le", "utf-16be",
    "us-ascii", "ascii", "iso-8859-1", "latin1", "windows-1252"
  ]);
  const normalizedCharset = charset[1].toLowerCase();
  return `${mimeType}; charset=${supportedCharsets.has(normalizedCharset) ? normalizedCharset : "unsupported"}`;
}

function decodeSubscriptionBody(buffer, contentType) {
  let encoding = "utf-8";
  let offset = 0;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    offset = 3;
  } else {
    const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(String(contentType || ""));
    if (charset) {
      const requested = charset[1].toLowerCase();
      const supportedCharsets = {
        utf8: "utf-8",
        "utf-8": "utf-8",
        "utf-16": "utf-16le",
        "utf-16le": "utf-16le",
        "utf-16be": "utf-16be",
        "us-ascii": "windows-1252",
        ascii: "windows-1252",
        "iso-8859-1": "windows-1252",
        latin1: "windows-1252",
        "windows-1252": "windows-1252"
      };
      encoding = supportedCharsets[requested];
      if (!encoding) throw new Error("Subscription response uses an unsupported text encoding.");
    }
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer.subarray(offset));
  } catch (error) {
    throw new Error("Subscription response text could not be decoded.");
  }
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
        const contentType = safeContentType(response.headers["content-type"]);
        response.resume();
        reject(new Error(`Subscription server returned HTTP ${status} (${contentType}).`));
        return;
      }

      const contentType = response.headers["content-type"] || "";
      const contentEncoding = String(response.headers["content-encoding"] || "identity").toLowerCase().trim();
      const decompressors = {
        gzip: () => zlib.createGunzip(),
        "x-gzip": () => zlib.createGunzip(),
        deflate: () => zlib.createInflate(),
        br: () => zlib.createBrotliDecompress()
      };
      let decodedStream = response;
      if (contentEncoding !== "" && contentEncoding !== "identity") {
        if (!Object.prototype.hasOwnProperty.call(decompressors, contentEncoding)
            || typeof zlib.createBrotliDecompress !== "function" && contentEncoding === "br") {
          response.resume();
          reject(new Error("Subscription server returned an unsupported content encoding."));
          return;
        }
        decodedStream = decompressors[contentEncoding]();
      }

      const chunks = [];
      let responseBytes = 0;
      let decodedBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > 5 * 1024 * 1024) {
          const error = new Error("Subscription response is larger than 5 MB.");
          response.destroy();
          if (decodedStream !== response) decodedStream.destroy();
          fail(error);
        }
      });
      decodedStream.on("data", (chunk) => {
        decodedBytes += chunk.length;
        if (decodedBytes > 5 * 1024 * 1024) {
          const error = new Error("Subscription response is larger than 5 MB.");
          response.destroy();
          if (decodedStream !== response) decodedStream.destroy();
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", fail);
      if (decodedStream !== response) decodedStream.on("error", fail);
      decodedStream.on("end", () => {
        if (settled) return;
        try {
          const body = Buffer.concat(chunks);
          const text = decodeSubscriptionBody(body, contentType);
          settled = true;
          resolve({
            text: text,
            diagnostics: {
              httpStatus: status,
              contentType: safeContentType(contentType),
              responseBytes: responseBytes,
              decodedBytes: decodedBytes
            }
          });
        } catch (error) {
          fail(error);
        }
      });
      if (decodedStream !== response) response.pipe(decodedStream);
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

function getCoreManagerPath() {
  const applicationDirectory = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const executableName = process.platform === "win32" ? "choobs-core-manager.exe" : "choobs-core-manager";
  return path.join(applicationDirectory, "backend", executableName);
}

function ensureCoreManager() {
  if (coreManagerProcess && !coreManagerProcess.killed) return coreManagerProcess;
  const executablePath = getCoreManagerPath();
  if (!fs.existsSync(executablePath)) {
    throw new Error("Core Manager executable not found. Build backend/choobs-core-manager before starting the desktop app.");
  }

  const managerProcess = spawn(executablePath, [], {
    cwd: path.dirname(path.dirname(executablePath)),
    env: Object.assign({}, process.env, { CHOOBS_DATA_DIRECTORY: app.getPath("userData") }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  coreManagerProcess = managerProcess;
  const output = readline.createInterface({ input: managerProcess.stdout });
  output.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      if (coreManagerPending) {
        coreManagerPending.reject(new Error("Core Manager returned an invalid response."));
        coreManagerPending = null;
      }
      return;
    }
    if (!coreManagerPending || response.id !== coreManagerPending.id) return;
    coreManagerPending.resolve(response.status);
    updateTrayStatus(response.status);
    if (coreManagerPending.notifyRenderer && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("core:status-changed", response.status);
    }
    coreManagerPending = null;
  });
  managerProcess.on("error", (error) => {
    if (coreManagerPending) {
      coreManagerPending.reject(new Error(`Could not start Core Manager: ${error.message}`));
      coreManagerPending = null;
    }
    if (coreManagerProcess === managerProcess) coreManagerProcess = null;
  });
  managerProcess.on("exit", (code) => {
    output.close();
    if (coreManagerPending) {
      coreManagerPending.reject(new Error(`Core Manager exited unexpectedly (${code === null ? "unknown" : code}).`));
      coreManagerPending = null;
    }
    if (coreManagerProcess === managerProcess) coreManagerProcess = null;
  });
  managerProcess.stderr.on("data", (chunk) => {
    console.error(`Core Manager: ${chunk.toString().trim()}`);
  });
  return managerProcess;
}

function callCoreManager(command, server, notifyRenderer) {
  const run = async () => {
    const managerProcess = ensureCoreManager();
    const id = `core-${++coreManagerRequestId}`;
    const request = { id, command };
    if (server) request.server = server;
    return new Promise((resolve, reject) => {
      coreManagerPending = { id, command, notifyRenderer: Boolean(notifyRenderer), resolve, reject };
      managerProcess.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error && coreManagerPending && coreManagerPending.id === id) {
          coreManagerPending = null;
          reject(new Error(`Could not send command to Core Manager: ${error.message}`));
        }
      });
    });
  };
  const result = coreManagerQueue.then(run, run);
  coreManagerQueue = result.then(() => undefined, () => undefined);
  return result;
}

function validateCoreServer(serverId) {
  if (typeof serverId !== "string" || !serverId.trim()) {
    throw new Error("Select a saved server before starting the core.");
  }
  const storedServer = configStore.load().config.servers.find((item) => item.id === serverId);
  if (!storedServer) throw new Error("Selected server is no longer available. Refresh the server list.");
  if (typeof storedServer.uri !== "string" || !storedServer.uri || storedServer.uri.length > 8192
      || typeof storedServer.address !== "string" || !storedServer.address.trim()
      || !Number.isInteger(storedServer.port) || storedServer.port < 1 || storedServer.port > 65535) {
    throw new Error("Selected server does not have a supported connection configuration.");
  }
  return {
    id: storedServer.id,
    name: storedServer.name,
    protocol: storedServer.protocol,
    address: storedServer.address,
    port: storedServer.port,
    uri: storedServer.uri
  };
}

function registerIpcHandlers() {
  ipcMain.handle("choobs:load-config", () => configStore.load());
  ipcMain.handle("choobs:save-config", (_event, config) => {
    const saved = configStore.save(config);
    updateTrayStatus(trayStatus);
    return saved;
  });
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
  ipcMain.handle("choobs:set-start-with-windows", (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Start with Windows must be enabled or disabled.");
    if (process.platform !== "win32") throw new Error("Start with Windows is available only on Windows.");
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ["--hidden"]
    });
    return app.getLoginItemSettings().openAtLogin === enabled;
  });
  ipcMain.handle("core:start", (_event, serverId) => callCoreManager("start", validateCoreServer(serverId)));
  ipcMain.handle("core:stop", () => callCoreManager("stop"));
  ipcMain.handle("core:restart", (_event, serverId) => {
    const selectedServer = typeof serverId === "undefined" ? undefined : validateCoreServer(serverId);
    return callCoreManager("restart", selectedServer);
  });
  ipcMain.handle("core:status", () => callCoreManager("status"));
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
      favorites: Array.isArray(payload.favorites) ? payload.favorites : [],
      settings: payload.settings && typeof payload.settings === "object" ? payload.settings : {}
    }, null, 2)}\n`, "utf8");
    return true;
  });
}

function currentSavedServer() {
  const config = configStore.load().config;
  const server = config.servers.find((item) => item.id === config.selectedServerId);
  if (!server) return null;
  return { config, server };
}

function updateTrayStatus(status) {
  trayStatus = status || trayStatus;
  if (!tray) return;
  const saved = currentSavedServer();
  const connected = Boolean(trayStatus.running || trayStatus.code === "PROXY_RESTORE_FAILED");
  const menuItems = [
    { label: "Choobs", enabled: false },
    { type: "separator" },
    {
      label: connected ? "Disconnect" : "Connect",
      enabled: !trayActionPending && (connected || Boolean(saved)),
      click: async () => {
        if (trayActionPending) return;
        trayActionPending = true;
        updateTrayStatus(trayStatus);
        try {
          const status = connected
            ? await callCoreManager("stop", undefined, true)
            : await callCoreManager("start", validateCoreServer(saved.server.id), true);
          updateTrayStatus(status);
          if (status.state !== "running" && status.state !== "stopped") {
            tray.displayBalloon({
              title: "Choobs",
              content: status.error || "The requested connection action failed."
            });
          }
        } catch (error) {
          tray.displayBalloon({ title: "Choobs", content: error.message });
        } finally {
          trayActionPending = false;
          updateTrayStatus(trayStatus);
        }
      }
    },
    {
      label: saved ? `Server: ${saved.server.location || saved.server.name}` : "No server selected",
      enabled: false
    },
    { type: "separator" },
    {
      label: "Open Choobs",
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        mainWindow.show();
        mainWindow.focus();
      }
    },
    {
      label: "Exit",
      click: () => {
        exitRequested = true;
        app.quit();
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

function createTray() {
  if (process.platform !== "win32" || tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(iconDirectory, "choobs-32.png")));
  tray.setToolTip("Choobs");
  tray.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow.show();
    mainWindow.focus();
  });
  updateTrayStatus(trayStatus);
}

function shouldMinimizeToTray() {
  if (!configStore) return false;
  return configStore.load().config.settings.minimizeToTray
    || Boolean(trayStatus.running || trayStatus.code === "PROXY_RESTORE_FAILED");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#111315",
    icon: path.join(
      iconDirectory,
      process.platform === "win32" ? "choobs.ico" : "choobs-256.png"
    ),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "app", "index.html"));
  mainWindow.on("close", (event) => {
    if (!quitAfterCoreStop && !exitRequested && shouldMinimizeToTray()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (ownsSingleInstanceLock) {
  app.whenReady().then(() => {
    configStore = new ConfigStore(path.join(app.getPath("userData"), "choobs-config.json"));
    configStore.load({ resetSelection: true });
    registerIpcHandlers();
    createTray();
    createWindow();
    if (process.argv.includes("--hidden") && shouldMinimizeToTray()) mainWindow.hide();
  });
} else {
  app.quit();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !(tray && shouldMinimizeToTray())) app.quit();
});

let quitAfterCoreStop = false;
app.on("before-quit", (event) => {
  if (quitAfterCoreStop) return;
  if (!coreManagerProcess) {
    quitAfterCoreStop = true;
    return;
  }
  event.preventDefault();
  quitAfterCoreStop = true;
  callCoreManager("stop").then(async (status) => {
    if (!status || status.running || status.code === "PROXY_RESTORE_FAILED") {
      throw new Error(status && status.error
        ? status.error
        : "The VPN core is still running, so Choobs cannot safely exit.");
    }
    if (coreManagerProcess && !coreManagerProcess.killed) coreManagerProcess.stdin.end();
    app.quit();
  }).catch(async (error) => {
    quitAfterCoreStop = false;
    exitRequested = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Choobs could not safely disconnect",
        message: "Choobs will remain open so you can retry disconnecting.",
        detail: error.message,
        buttons: ["Keep Choobs open"]
      });
    } else if (tray) {
      tray.displayBalloon({
        title: "Choobs could not safely disconnect",
        content: "Choobs remains available in the system tray. Open it to retry disconnecting."
      });
    } else {
      await dialog.showMessageBox({
      type: "warning",
      title: "Choobs could not safely disconnect",
      message: "Choobs will remain open so you can retry disconnecting.",
      detail: error.message,
      buttons: ["Keep Choobs open"]
      });
    }
  });
});

app.on("will-quit", () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
});
