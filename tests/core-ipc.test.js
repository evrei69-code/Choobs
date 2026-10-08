const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { test } = require("node:test");
const zlib = require("node:zlib");

test("preload exposes restricted core IPC and main validates the stored server", async (t) => {
  const handlers = new Map();
  const exposed = {};
  const applicationDirectory = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "choobs-core-ipc-"));
  const managerRequests = [];
  const closeWarnings = [];
  let stopStatus = { running: false, pid: null, state: "stopped" };
  let quitCount = 0;
  const originalHttpsGet = https.get;
  const app = new EventEmitter();
  app.isPackaged = false;
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  app.getAppPath = () => applicationDirectory;
  app.getPath = (name) => name === "userData" ? userData : os.tmpdir();
  app.quit = () => { quitCount += 1; };

  let managerChild;
  let spawnDetails;
  const originalExistsSync = fs.existsSync;
  const originalLoad = Module._load;
  fs.existsSync = function (filePath) {
    if (path.basename(filePath) === "choobs-core-manager") return true;
    return originalExistsSync.call(this, filePath);
  };

  const electron = {
    app,
    BrowserWindow: class {
      loadFile() {}
      on() {}
      static getAllWindows() { return []; }
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async (_window, options) => { closeWarnings.push(options); }
    },
    ipcMain: {
      handle(name, handler) { handlers.set(name, handler); }
    },
    contextBridge: {
      exposeInMainWorld(name, value) { exposed[name] = value; }
    },
    ipcRenderer: {
      invoke(name, ...args) {
        const handler = handlers.get(name);
        if (!handler) return Promise.reject(new Error(`No IPC handler for ${name}`));
        try {
          return Promise.resolve(handler({}, ...args));
        } catch (error) {
          return Promise.reject(error);
        }
      }
    }
  };

  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "child_process") {
      const childProcess = originalLoad.call(this, request, parent, isMain);
      return Object.assign({}, childProcess, {
        spawn(...args) {
          spawnDetails = args;
          managerChild = new EventEmitter();
          managerChild.killed = false;
          managerChild.stdout = new PassThrough();
          managerChild.stderr = new PassThrough();
          managerChild.stdin = new Writable({
            write(chunk, _encoding, callback) {
              const request = JSON.parse(String(chunk).trim());
              managerRequests.push(request);
              const status = request.command === "stop"
                ? stopStatus
                : request.command === "status"
                  ? { running: false, pid: null, state: "stopped" }
                  : { running: false, pid: null, state: "error", code: "CORE_NOT_FOUND", error: "VPN core not found." };
              managerChild.stdout.write(`${JSON.stringify({ id: request.id, status })}\n`);
              callback();
            }
          });
          return managerChild;
        }
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  t.after(() => {
    if (managerChild) {
      managerChild.stdin.end();
      managerChild.stdout.end();
      managerChild.stderr.end();
      managerChild.emit("exit", 0);
    }
    Module._load = originalLoad;
    fs.existsSync = originalExistsSync;
    https.get = originalHttpsGet;
    fs.rmSync(userData, { recursive: true, force: true });
    delete require.cache[require.resolve("../main.js")];
    delete require.cache[require.resolve("../preload.js")];
  });

  require("../main.js");
  require("../preload.js");
  await new Promise((resolve) => setImmediate(resolve));

  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    process.nextTick(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      const compressedBody = zlib.gzipSync(Buffer.from("safe synthetic feed", "utf8"));
      response.headers = { "content-type": "application/octet-stream; charset=UTF-8", "content-encoding": "gzip" };
      callback(response);
      response.end(compressedBody);
    });
    return request;
  };
  const fetched = await exposed.choobs.fetchSubscription("https://subscriptions.example/safe-test");
  assert.equal(fetched.text, "safe synthetic feed");
  assert.deepEqual(fetched.diagnostics, {
    httpStatus: 200,
    contentType: "application/octet-stream; charset=utf-8",
    responseBytes: zlib.gzipSync(Buffer.from("safe synthetic feed", "utf8")).length,
    decodedBytes: Buffer.byteLength("safe synthetic feed")
  });

  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    process.nextTick(() => {
      const response = new PassThrough();
      const body = Buffer.from("utf16 safe body", "utf16le");
      response.statusCode = 200;
      response.headers = { "content-type": "text/plain; charset=utf-16le", "content-encoding": "identity" };
      callback(response);
      response.end(body);
    });
    return request;
  };
  const utf16 = await exposed.choobs.fetchSubscription("https://subscriptions.example/safe-test");
  assert.equal(utf16.text, "utf16 safe body");
  assert.equal(utf16.diagnostics.contentType, "text/plain; charset=utf-16le");
  assert.equal(utf16.diagnostics.decodedBytes, Buffer.byteLength("utf16 safe body", "utf16le"));

  https.get = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    process.nextTick(() => {
      const response = new PassThrough();
      response.statusCode = 503;
      response.headers = { "content-type": "text/html; charset=utf-8" };
      callback(response);
      response.end("synthetic HTTP error body");
    });
    return request;
  };
  await assert.rejects(
    exposed.choobs.fetchSubscription("https://subscriptions.example/safe-test"),
    /HTTP 503 \(text\/html; charset=utf-8\)/
  );
  https.get = originalHttpsGet;

  for (const method of ["startCore", "stopCore", "restartCore", "getCoreStatus"]) {
    assert.equal(typeof exposed.choobs[method], "function");
  }

  const server = {
    id: "saved-vless",
    name: "Test",
    location: "Test",
    address: "example.net",
    port: 443,
    protocol: "VLESS",
    uri: "vless://123e4567-e89b-12d3-a456-426614174000@example.net:443"
  };
  await exposed.choobs.saveConfig({
    servers: [server],
    subscriptions: [],
    selectedServerId: server.id,
    settings: {}
  });

  const status = await exposed.choobs.getCoreStatus();
  assert.equal(status.state, "stopped");

  const missing = await exposed.choobs.startCore(server.id);
  assert.equal(missing.state, "error");
  assert.equal(missing.code, "CORE_NOT_FOUND");
  const startRequest = managerRequests.find((request) => request.command === "start");
  assert.equal(startRequest.server.address, "example.net");
  assert.equal("executablePath" in startRequest.server, false);
  assert.equal(spawnDetails[0], path.join(applicationDirectory, "backend", "choobs-core-manager"));
  assert.notEqual(spawnDetails[2].shell, true);

  const rejected = await exposed.choobs.startCore({
    id: server.id,
    address: "attacker.example",
    executablePath: "/tmp/attacker"
  }).then(
    () => false,
    () => true
  );
  assert.equal(rejected, true);
  const unknownServer = await exposed.choobs.startCore("not-in-config").then(
    () => false,
    () => true
  );
  assert.equal(unknownServer, true);
  assert.equal(managerRequests.filter((request) => request.command === "start").length, 1);

  const stopped = await exposed.choobs.stopCore();
  assert.equal(stopped.state, "stopped");

  stopStatus = {
    running: true,
    pid: 123,
    state: "error",
    code: "PROXY_RESTORE_FAILED",
    error: "Could not restore previous Windows proxy settings."
  };
  let prevented = false;
  app.emit("before-quit", { preventDefault() { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prevented, true);
  assert.equal(quitCount, 0);
  assert.match(closeWarnings[0].message, /remain open/);

  stopStatus = { running: false, pid: null, state: "stopped" };
  app.emit("before-quit", { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(quitCount, 1);
});
