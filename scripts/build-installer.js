const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backend = path.join(root, "backend");
const managerPath = path.join(backend, "choobs-core-manager.exe");
const iconPath = path.join(root, "build", "choobs.ico");
const singBoxPath = path.join(root, "core", "bin", "sing-box.exe");
const xrayPath = path.join(root, "core", "bin", "xray.exe");
const coreHashesPath = path.join(backend, "core-hashes.json");
const packagedManagerPath = path.join(root, "dist", "win-unpacked", "resources", "backend", "choobs-core-manager.exe");
const packagedSingBoxPath = path.join(root, "dist", "win-unpacked", "resources", "core", "bin", "sing-box.exe");
const packagedXrayPath = path.join(root, "dist", "win-unpacked", "resources", "core", "bin", "xray.exe");
const packagedCoreHashesPath = path.join(root, "dist", "win-unpacked", "resources", "backend", "core-hashes.json");
const go = process.platform === "win32" ? "go.exe" : "go";
const coreHashes = JSON.parse(fs.readFileSync(path.join(backend, "core-hashes.json"), "utf8"));
const expectedCoreHashesHash = crypto.createHash("sha256").update(fs.readFileSync(coreHashesPath)).digest("hex");
const expectedSingBoxHash = coreHashes["sing-box"].sha256;
const expectedXrayHash = coreHashes.xray.sha256;
const electronVersion = require("../node_modules/electron/package.json").version;
const builderVersion = require("../node_modules/electron-builder/package.json").version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed with exit code ${result.status}`);
  }
  return result.stdout.trim();
}

function build() {
  if (electronVersion !== "22.3.27" || builderVersion !== "26.15.3") {
    throw new Error("Windows 7 installer builds require Electron 22.3.27 and electron-builder 26.15.3.");
  }
  if (process.platform === "linux") {
    const wine = spawnSync("wine", ["--version"], { encoding: "utf8" });
    if (wine.error) {
      if (wine.error.code === "ENOENT") {
        throw new Error("NSIS installer builds on Linux require Wine on PATH.");
      }
      throw wine.error;
    }
    if (wine.status !== 0) throw new Error("Wine could not run; electron-builder requires it for NSIS on Linux.");
  }
  if (!/\bgo1\.20\.14\b/.test(capture(go, ["version"]))) {
    throw new Error("Windows 7 installer builds require Go 1.20.14 on PATH.");
  }
  for (const [filePath, label] of [
    [iconPath, "Windows application icon"],
    [singBoxPath, "Windows x64 sing-box binary"],
    [xrayPath, "verified Windows x64 Xray 24.11.30 binary"]
  ]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required ${label} is missing: ${path.relative(root, filePath)}.`);
    }
  }
  const singBoxHash = crypto.createHash("sha256").update(fs.readFileSync(singBoxPath)).digest("hex");
  if (singBoxHash !== expectedSingBoxHash) {
    throw new Error("core/bin/sing-box.exe does not match the verified Windows 7 legacy binary checksum.");
  }
  const xrayHash = crypto.createHash("sha256").update(fs.readFileSync(xrayPath)).digest("hex");
  if (xrayHash !== expectedXrayHash) {
    throw new Error("core/bin/xray.exe does not match the verified Xray 24.11.30 Windows 7 binary checksum.");
  }

  run(go, ["build", "-C", backend, "-trimpath", "-ldflags=-s -w", "-o", managerPath, "."], {
    env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" }
  });
  run(process.execPath, [
    path.join(root, "node_modules", "electron-builder", "cli.js"),
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never"
  ]);

  for (const [filePath, label] of [
    [packagedManagerPath, "Core Manager"],
    [packagedSingBoxPath, "sing-box core"],
    [packagedXrayPath, "Xray core"],
    [packagedCoreHashesPath, "core hash manifest"]
  ]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Packaged installer runtime is missing the ${label}.`);
    }
  }
  const packagedSingBoxHash = crypto.createHash("sha256").update(fs.readFileSync(packagedSingBoxPath)).digest("hex");
  if (packagedSingBoxHash !== expectedSingBoxHash) {
    throw new Error("Packaged sing-box does not match the verified Windows 7 legacy binary.");
  }
  const packagedXrayHash = crypto.createHash("sha256").update(fs.readFileSync(packagedXrayPath)).digest("hex");
  if (packagedXrayHash !== expectedXrayHash) {
    throw new Error("Packaged Xray does not match the verified Xray 24.11.30 Windows 7 binary.");
  }
  const packagedCoreHashesHash = crypto.createHash("sha256").update(fs.readFileSync(packagedCoreHashesPath)).digest("hex");
  if (packagedCoreHashesHash !== expectedCoreHashesHash) {
    throw new Error("Packaged core hash manifest does not match backend/core-hashes.json.");
  }
}

try {
  build();
} catch (error) {
  console.error(`Windows installer build failed: ${error.message}`);
  process.exitCode = 1;
}
