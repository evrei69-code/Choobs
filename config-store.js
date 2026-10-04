const fs = require("fs");
const path = require("path");
const DEFAULT_SERVERS = require("./app/js/servers");

const PROTOCOLS = ["HTTPS", "SOCKS5", "VLESS", "VMess", "Trojan", "Shadowsocks", "Custom"];
const CONNECTION_MODES = ["System Proxy", "TUN", "Auto"];

function defaultConfig() {
  return {
    servers: DEFAULT_SERVERS.map((server) => Object.assign({}, server)),
    selectedServerId: "nl-amsterdam",
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

function normalizeServer(server, index) {
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;

  const name = typeof server.name === "string" ? server.name.trim() : "";
  const location = typeof server.location === "string" ? server.location.trim() : "";
  const port = Number(server.port);
  const protocol = PROTOCOLS.indexOf(server.protocol) !== -1 ? server.protocol : "";

  if (!name || !location || !Number.isInteger(port) || port < 1 || port > 65535 || !protocol) return null;

  const ping = server.ping === "" || server.ping === null || typeof server.ping === "undefined"
    ? null
    : Number(server.ping);

  if (ping !== null && (!Number.isFinite(ping) || ping < 0)) return null;
  if (typeof server.address !== "undefined" && typeof server.address !== "string") return null;
  if (typeof server.description !== "undefined" && typeof server.description !== "string") return null;

  return {
    id: typeof server.id === "string" && server.id.trim() ? server.id.trim() : `server-${index + 1}`,
    name,
    location,
    flag: typeof server.flag === "string" ? server.flag.trim() : "",
    address: typeof server.address === "string" ? server.address.trim() : "",
    port,
    protocol,
    ping,
    description: typeof server.description === "string" ? server.description.trim() : ""
  };
}

function normalizeConfig(value) {
  const fallback = defaultConfig();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { config: fallback, warning: "Configuration was invalid; default settings were loaded." };
  }

  let servers = fallback.servers;
  let warning = "";

  if (Array.isArray(value.servers) && value.servers.length > 0) {
    const normalized = value.servers.map(normalizeServer);
    if (normalized.every(Boolean)) {
      servers = normalized;
    } else {
      warning = "Some saved server data was invalid; default servers were loaded.";
    }
  } else if (typeof value.servers !== "undefined") {
    warning = "Saved server list was invalid; default servers were loaded.";
  }

  const ids = {};
  servers = servers.map((server, index) => {
    const copy = Object.assign({}, server);
    if (ids[copy.id]) copy.id = `${copy.id}-${index + 1}`;
    ids[copy.id] = true;
    return copy;
  });

  const inputSettings = value.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
    ? value.settings
    : {};
  const settings = Object.assign({}, fallback.settings);
  [
    "startWithWindows",
    "autoConnect",
    "minimizeToTray",
    "rememberSelectedServer",
    "connectOnStart"
  ].forEach((key) => {
    if (typeof inputSettings[key] === "boolean") settings[key] = inputSettings[key];
  });
  if (CONNECTION_MODES.indexOf(inputSettings.connectionMode) !== -1) {
    settings.connectionMode = inputSettings.connectionMode;
  }

  const selectedServerId = settings.rememberSelectedServer
    && servers.some((server) => server.id === value.selectedServerId)
    ? value.selectedServerId
    : servers[0].id;

  return {
    config: { servers, selectedServerId, settings },
    warning
  };
}

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      const config = defaultConfig();
      this.save(config);
      return { config, warning: "" };
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const result = normalizeConfig(JSON.parse(raw));
      this.save(result.config);
      return result;
    } catch (error) {
      if (error instanceof SyntaxError) {
        const config = defaultConfig();
        this.save(config);
        return { config, warning: "Configuration file was damaged; default settings were loaded." };
      }
      throw error;
    }
  }

  save(value) {
    const result = normalizeConfig(value);
    if (result.warning) throw new Error("Configuration contains invalid server data.");

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(result.config, null, 2)}\n`, "utf8");
    return result.config;
  }
}

module.exports = {
  ConfigStore,
  DEFAULT_SERVERS,
  PROTOCOLS,
  defaultConfig,
  normalizeConfig,
  normalizeServer
};
