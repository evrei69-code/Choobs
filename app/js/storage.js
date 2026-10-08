(function (global) {
  var STORAGE_KEY = "choobs-preview-config";
  var desktopApi = global.choobs;

  function makeDefaultConfig() {
    return {
      servers: [],
      subscriptions: [],
      selectedServerId: null,
      settings: {
        startWithWindows: false,
        autoConnect: false,
        minimizeToTray: false,
        connectionMode: "System Proxy",
        rememberSelectedServer: true,
        connectOnStart: false,
        autoUpdateSubscriptions: false,
        subscriptionUpdateInterval: "manual"
      }
    };
  }

  function normalizePreviewConfig(config) {
    if (!config || typeof config !== "object") return null;

    var servers = Array.isArray(config.servers) ? config.servers : [];
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

    var subscriptions = Array.isArray(config.subscriptions) ? config.subscriptions : [];
    if (!subscriptions.every(function (subscription) {
      return subscription && typeof subscription.id === "string" && typeof subscription.name === "string"
        && typeof subscription.url === "string" && Array.isArray(subscription.servers);
    })) return null;
    subscriptions.forEach(function (subscription) {
      subscription.servers.forEach(function (server) {
        if (!servers.some(function (item) { return item.id === server.id; })) servers.push(server);
      });
    });

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
    if (["manual", "15m", "30m", "1h", "6h", "12h", "24h"].indexOf(settings.subscriptionUpdateInterval) === -1) {
      settings.subscriptionUpdateInterval = "manual";
    }

    var selectedServerId = settings.rememberSelectedServer
      && servers.some(function (server) { return server.id === config.selectedServerId; })
      ? config.selectedServerId
      : (servers.length ? servers[0].id : null);

    return {
      servers: servers,
      subscriptions: subscriptions,
      selectedServerId: selectedServerId,
      settings: settings
    };
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
        if (file.size > 5 * 1024 * 1024) {
          reject(new Error("The selected file is larger than 5 MB."));
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
      var payload = Array.isArray(servers)
        ? { subscriptions: [], servers: servers }
        : Object.assign({ format: "choobs-config", version: 1 }, servers);
      var blob = new global.Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
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

  function safeContentType(value) {
    var contentType = String(value || "");
    var mimeType = contentType.split(";")[0].trim().toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) return "unknown";
    var charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
    if (!charset) return mimeType;
    var normalizedCharset = charset[1].toLowerCase();
    var supportedCharsets = ["utf8", "utf-8", "utf-16", "utf-16le", "utf-16be", "us-ascii", "ascii", "iso-8859-1", "latin1", "windows-1252"];
    return `${mimeType}; charset=${supportedCharsets.indexOf(normalizedCharset) !== -1 ? normalizedCharset : "unsupported"}`;
  }

  function fetchSubscription(url) {
    if (desktopApi && typeof desktopApi.fetchSubscription === "function") {
      return desktopApi.fetchSubscription(url);
    }

    if (typeof global.fetch !== "function") {
      return Promise.reject(new Error("Subscription downloads are not available in this browser."));
    }

    return global.fetch(url, { method: "GET", credentials: "omit", cache: "no-store" }).then(function (response) {
      var length = Number(response.headers.get("content-length"));
      if (length > 5 * 1024 * 1024) throw new Error("Subscription response is larger than 5 MB.");
      if (!response.ok) throw new Error(`Subscription server returned HTTP ${response.status}.`);
      return response.text().then(function (text) {
        if (text.length > 5 * 1024 * 1024) throw new Error("Subscription response is larger than 5 MB.");
        return {
          text: text,
          diagnostics: {
            httpStatus: response.status,
            contentType: safeContentType(response.headers.get("content-type")),
            responseBytes: typeof global.TextEncoder === "function"
              ? new global.TextEncoder().encode(text).length
              : text.length,
            decodedBytes: typeof global.TextEncoder === "function"
              ? new global.TextEncoder().encode(text).length
              : text.length
          }
        };
      });
    }).catch(function (error) {
      if (error && error.message && error.message.indexOf("Subscription server returned HTTP ") === 0) throw error;
      if (error && error.message && error.message.indexOf("Subscription response is larger") === 0) throw error;
      throw new Error("Could not load subscription. Browser CORS restrictions may block this URL; try the desktop app.");
    });
  }

  function pingServer(server) {
    if (desktopApi && typeof desktopApi.pingServer === "function") {
      return desktopApi.pingServer(server);
    }
    return Promise.reject(new Error("TCP ping checks are unavailable in browser preview."));
  }

  global.ChoobsStorage = {
    isPreview: !(desktopApi && typeof desktopApi.loadConfig === "function"),
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    importServers: importServers,
    exportServers: exportServers,
    fetchSubscription: fetchSubscription,
    pingServer: pingServer
  };
}(window));
