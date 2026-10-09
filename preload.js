const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("choobs", {
  loadConfig: () => ipcRenderer.invoke("choobs:load-config"),
  saveConfig: (config) => ipcRenderer.invoke("choobs:save-config", config),
  importServers: () => ipcRenderer.invoke("choobs:import-servers"),
  exportServers: (data) => ipcRenderer.invoke("choobs:export-servers", data),
  fetchSubscription: (url) => ipcRenderer.invoke("choobs:fetch-subscription", url),
  pingServer: (server) => ipcRenderer.invoke("choobs:ping-server", server),
  setStartWithWindows: (enabled) => ipcRenderer.invoke("choobs:set-start-with-windows", enabled),
  onCoreStatus: (callback) => {
    if (typeof callback !== "function") throw new TypeError("Core status callback must be a function.");
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("core:status-changed", listener);
    return () => ipcRenderer.removeListener("core:status-changed", listener);
  },
  startCore: (serverId) => ipcRenderer.invoke("core:start", serverId),
  stopCore: () => ipcRenderer.invoke("core:stop"),
  restartCore: (serverId) => ipcRenderer.invoke("core:restart", serverId),
  getCoreStatus: () => ipcRenderer.invoke("core:status")
});
