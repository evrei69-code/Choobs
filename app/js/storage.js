(function (global) {
  var STORAGE_KEY = "choobs-preview-config";
  var desktopApi = global.choobs;

  function makeDefaultConfig() {
    return {
      servers: global.servers.map(function (server) {
        return Object.assign({}, server);
      }),
      selectedServerId: global.servers[0].id,
      settings: {
        startWithWindows: false,
        autoConnect: false,
        minimizeToTray: false,
        connectionMode: "System Proxy",
        rememberSelectedServer: true,
        connectOnStart: false
      }
    };
  }

  function normalizePreviewConfig(config) {
    if (!config || typeof config !== "object" || !Array.isArray(config.servers) || config.servers.length === 0) {
      return null;
    }

    var servers = config.servers;
    var validServers = servers.every(function (server) {
      return server
        && typeof server === "object"
        && typeof server.id === "string"
        && typeof server.name === "string"
        && server.name.trim()
        && typeof server.location === "string"
        && server.location.trim();
    });
    if (!validServers) return null;

    var defaults = makeDefaultConfig();
    var settings = Object.assign({}, defaults.settings);
    if (config.settings && typeof config.settings === "object") {
      Object.keys(defaults.settings).forEach(function (key) {
        if (typeof config.settings[key] === typeof defaults.settings[key]) {
          settings[key] = config.settings[key];
        }
      });
    }
    if (["System Proxy", "TUN", "Auto"].indexOf(settings.connectionMode) === -1) {
      settings.connectionMode = defaults.settings.connectionMode;
    }

    var selectedServerId = settings.rememberSelectedServer
      && servers.some(function (server) { return server.id === config.selectedServerId; })
      ? config.selectedServerId
      : servers[0].id;

    return { servers: servers, selectedServerId: selectedServerId, settings: settings };
  }

  function loadConfig() {
    if (desktopApi && typeof desktopApi.loadConfig === "function") {
      return desktopApi.loadConfig();
    }

    try {
      var saved = global.localStorage.getItem(STORAGE_KEY);
      if (!saved) return Promise.resolve({ config: makeDefaultConfig(), warning: "" });
      var normalized = normalizePreviewConfig(JSON.parse(saved));
      if (!normalized) {
        return Promise.resolve({
          config: makeDefaultConfig(),
          warning: "Saved preview configuration was invalid; default servers were loaded."
        });
      }
      return Promise.resolve({ config: normalized, warning: "" });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Promise.resolve({
          config: makeDefaultConfig(),
          warning: "Saved preview configuration was damaged; default servers were loaded."
        });
      }
      return Promise.reject(error);
    }
  }

  function saveConfig(config) {
    if (desktopApi && typeof desktopApi.saveConfig === "function") {
      return desktopApi.saveConfig(config);
    }

    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      return Promise.resolve(config);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function readBrowserFile() {
    return new Promise(function (resolve, reject) {
      var input = global.document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";
      global.document.body.appendChild(input);
      var removeInput = function () {
        if (input.parentNode) input.parentNode.removeChild(input);
      };
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        removeInput();
        if (!file) {
          resolve(null);
          return;
        }

        var reader = new global.FileReader();
        reader.onload = function () {
          try {
            resolve(JSON.parse(reader.result));
          } catch (error) {
            if (error instanceof SyntaxError) reject(new Error("This file is not valid JSON."));
            else reject(error);
          }
        };
        reader.onerror = function () {
          reject(reader.error || new Error("Could not read the selected file."));
        };
        reader.readAsText(file);
      });
      input.addEventListener("cancel", function () {
        removeInput();
        resolve(null);
      });
      input.click();
    });
  }

  function importServers() {
    if (desktopApi && typeof desktopApi.importServers === "function") {
      return desktopApi.importServers();
    }
    return readBrowserFile();
  }

  function exportServers(servers) {
    if (desktopApi && typeof desktopApi.exportServers === "function") {
      return desktopApi.exportServers(servers);
    }

    try {
      var blob = new global.Blob([JSON.stringify({
        format: "choobs-servers",
        version: 1,
        servers: servers
      }, null, 2) + "\n"], { type: "application/json" });
      var url = global.URL.createObjectURL(blob);
      var link = global.document.createElement("a");
      link.href = url;
      link.download = "choobs-servers.json";
      link.style.display = "none";
      global.document.body.appendChild(link);
      link.click();
      global.document.body.removeChild(link);
      global.setTimeout(function () {
        global.URL.revokeObjectURL(url);
      }, 1000);
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  global.ChoobsStorage = {
    isPreview: !(desktopApi && typeof desktopApi.loadConfig === "function"),
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    importServers: importServers,
    exportServers: exportServers
  };
}(window));
