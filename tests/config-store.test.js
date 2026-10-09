const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { ConfigStore, defaultConfig, normalizeConfig } = require("../config-store");

const server = {
  id: "safe-server-id",
  name: "Finland",
  location: "Helsinki",
  address: "example.invalid",
  port: 443,
  protocol: "VLESS",
  uri: "vless://synthetic@example.invalid:443"
};

test("favorites persist separately and stale favorite ids are harmless", () => {
  const normalized = normalizeConfig(Object.assign(defaultConfig(), {
    servers: [server],
    favorites: ["safe-server-id", "removed-server", "safe-server-id", "", null],
    selectedServerId: "safe-server-id"
  }));
  assert.deepEqual(normalized.config.favorites, ["safe-server-id", "removed-server"]);
  assert.equal(normalized.config.servers[0].source, undefined);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "choobs-config-test-"));
  try {
    const store = new ConfigStore(path.join(directory, "config.json"));
    store.save(normalized.config);
    assert.deepEqual(store.load().config.favorites, ["safe-server-id", "removed-server"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("auto-connect and optional best-server fallback stay opt-in", () => {
  const defaults = normalizeConfig(defaultConfig()).config;
  assert.equal(defaults.settings.autoConnect, false);
  assert.equal(defaults.settings.autoConnectBestServer, false);
  const enabled = normalizeConfig(Object.assign(defaultConfig(), {
    settings: { autoConnect: true, autoConnectBestServer: true }
  })).config.settings;
  assert.equal(enabled.autoConnect, true);
  assert.equal(enabled.autoConnectBestServer, true);
  const legacy = normalizeConfig(Object.assign(defaultConfig(), {
    settings: { connectOnStart: true }
  })).config.settings;
  assert.equal(legacy.autoConnect, true);
});

test("a stale remembered server is not silently replaced during startup", () => {
  const normalized = normalizeConfig(Object.assign(defaultConfig(), {
    servers: [server],
    selectedServerId: "removed-server-id",
    settings: { rememberSelectedServer: true }
  }));
  assert.equal(normalized.config.selectedServerId, null);
});

test("disabling remember-selection resets only on the next startup load", () => {
  const secondServer = Object.assign({}, server, { id: "second-server-id", name: "Netherlands" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "choobs-selection-test-"));
  try {
    const store = new ConfigStore(path.join(directory, "config.json"));
    store.save(Object.assign(defaultConfig(), {
      servers: [server, secondServer],
      selectedServerId: secondServer.id,
      settings: { rememberSelectedServer: false }
    }));
    assert.equal(store.load({ resetSelection: true }).config.selectedServerId, server.id);
    const duringSession = store.load().config;
    duringSession.selectedServerId = secondServer.id;
    assert.equal(store.save(duringSession).selectedServerId, secondServer.id);
    assert.equal(store.load().config.selectedServerId, secondServer.id);
    assert.equal(store.load({ resetSelection: true }).config.selectedServerId, server.id);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
