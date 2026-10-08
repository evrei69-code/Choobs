const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("choobs", {
  loadConfig: () => ipcRenderer.invoke("choobs:load-config"),
  saveConfig: (config) => ipcRenderer.invoke("choobs:save-config", config),
  importServers: () => ipcRenderer.invoke("choobs:import-servers"),
  exportServers: (data) => ipcRenderer.invoke("choobs:export-servers", data),
  fetchSubscription: (url) => ipcRenderer.invoke("choobs:fetch-subscription", url),
  pingServer: (server) => ipcRenderer.invoke("choobs:ping-server", server),
  startCore: (serverId) => ipcRenderer.invoke("core:start", serverId),
  stopCore: () => ipcRenderer.invoke("core:stop"),
  restartCore: (serverId) => ipcRenderer.invoke("core:restart", serverId),
  getCoreStatus: () => ipcRenderer.invoke("core:status")
});
