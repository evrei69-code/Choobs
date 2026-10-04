const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("choobs", {
  loadConfig: () => ipcRenderer.invoke("choobs:load-config"),
  saveConfig: (config) => ipcRenderer.invoke("choobs:save-config", config),
  importServers: () => ipcRenderer.invoke("choobs:import-servers"),
  exportServers: (servers) => ipcRenderer.invoke("choobs:export-servers", servers)
});
