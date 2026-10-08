const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backend = path.join(root, "backend");
const go = process.platform === "win32" ? "go.exe" : "go";
const managerPath = path.join(backend, "choobs-core-manager.exe");
const singBoxPath = path.join(root, "core", "bin", "sing-box.exe");
const appOutputPath = path.join(root, "dist", "win-unpacked");
const payloadPath = path.join(root, "dist", ".choobs-runtime.zip");
const bootstrapPath = path.join(root, "dist", ".Choobs-bootstrap.exe");
const outputPath = path.join(root, "dist", "Choobs.exe");
const expectedSingBoxHash = "99fb67d576d13fcdb9bf938f393a6d2016da306b9eff853dbdbc75e2092443cc";
const applicationVersion = require("../package.json").version;
const electronVersion = require("electron/package.json").version;
const builderVersion = require("electron-builder/package.json").version;

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

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed with exit code ${result.status}`);
  }
  return result.stdout.trim();
}

function goVersion() {
  return runCapture(go, ["version"]);
}

function verifyWindowsX64GuiExecutable(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length < 256 || data.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Compiled Choobs bootstrap is not a Windows PE executable.");
  }
  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset + 24 > data.length || data.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
    throw new Error("Compiled Choobs bootstrap has an invalid PE header.");
  }
  const machine = data.readUInt16LE(peOffset + 4);
  const optionalHeaderSize = data.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  if (machine !== 0x8664 || optionalHeaderSize < 70 || data.readUInt16LE(optionalHeader) !== 0x20b) {
    throw new Error("Compiled Choobs bootstrap must be a PE32+ x86-64 executable.");
  }
  if (data.readUInt16LE(optionalHeader + 68) !== 2) {
    throw new Error("Compiled Choobs bootstrap must use the Windows GUI subsystem.");
  }
  if (data.includes(Buffer.from("Nullsoft Install System"))) {
    throw new Error("Compiled Choobs bootstrap unexpectedly contains the NSIS launcher.");
  }
  const subsystemMajor = data.readUInt16LE(optionalHeader + 48);
  const subsystemMinor = data.readUInt16LE(optionalHeader + 50);
  if (subsystemMajor > 6 || (subsystemMajor === 6 && subsystemMinor > 1)) {
    throw new Error("Compiled Choobs bootstrap requests a Windows subsystem newer than Windows 7.");
  }
}

function cleanBuildOutputs() {
  for (const target of [
    appOutputPath,
    payloadPath,
    bootstrapPath,
    path.join(root, "dist", "builder-debug.yml")
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function build() {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("Build the single-file Windows package on Windows or Linux with Go 1.20.14.");
  }
  if (!fs.existsSync(singBoxPath)) {
    throw new Error("Required Windows x64 sing-box binary is missing from core/bin/sing-box.exe.");
  }
  const singBoxHash = crypto.createHash("sha256").update(fs.readFileSync(singBoxPath)).digest("hex");
  if (singBoxHash !== expectedSingBoxHash) {
    throw new Error("core/bin/sing-box.exe does not match the verified Windows 7 legacy binary checksum.");
  }
  if (!/\bgo1\.20\.14\b/.test(goVersion())) {
    throw new Error("Windows 7 portable builds require Go 1.20.14.");
  }
  if (electronVersion !== "22.3.27" || builderVersion !== "26.15.3") {
    throw new Error("Single-file packaging requires Electron 22.3.27 and electron-builder 26.15.3.");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });
  cleanBuildOutputs();
  try {
    run(go, ["build", "-C", backend, "-trimpath", "-ldflags=-s -w", "-o", managerPath, "."], {
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" }
    });
    run(process.execPath, [
      path.join(root, "node_modules", "electron-builder", "cli.js"),
      "--win",
      "dir",
      "--x64"
    ]);

    const requiredFiles = [
      path.join(appOutputPath, "Choobs.exe"),
      path.join(appOutputPath, "resources", "app.asar"),
      path.join(appOutputPath, "resources", "backend", "choobs-core-manager.exe"),
      path.join(appOutputPath, "resources", "core", "bin", "sing-box.exe")
    ];
    const missingFiles = requiredFiles.filter((filePath) => !fs.existsSync(filePath));
    if (missingFiles.length) {
      throw new Error(`Electron runtime is incomplete: ${missingFiles.map((filePath) => path.relative(root, filePath)).join(", ")}`);
    }
    if (!fs.readFileSync(path.join(appOutputPath, "Choobs.exe")).includes(Buffer.from("Electron/22.3.27"))) {
      throw new Error("Packaged Electron executable does not contain Electron 22.3.27.");
    }
    const packagedSingBoxHash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(appOutputPath, "resources", "core", "bin", "sing-box.exe")))
      .digest("hex");
    if (packagedSingBoxHash !== expectedSingBoxHash) {
      throw new Error("Packaged sing-box does not match the verified Windows 7 legacy binary.");
    }

    const packer = ["run", "-C", backend, "./cmd/choobs-pack"];
    const payloadHash = runCapture(go, [
      ...packer, "create", "-source-dir", appOutputPath, "-output", payloadPath
    ], { env: { ...process.env, GOTOOLCHAIN: "go1.20.14" } });
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
      throw new Error("Runtime packager returned an invalid SHA-256 value.");
    }
    run(go, [...packer, "verify", "-payload", payloadPath], {
      env: { ...process.env, GOTOOLCHAIN: "go1.20.14" }
    });

    const ldflags = `-s -w -H=windowsgui -X main.expectedPayloadHash=${payloadHash} -X main.applicationVersion=${applicationVersion}`;
    run(go, [
      "build",
      "-C", path.join(backend, "cmd", "choobs-bootstrap"),
      "-trimpath",
      `-ldflags=${ldflags}`,
      "-o", bootstrapPath,
      "."
    ], { env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" } });
    verifyWindowsX64GuiExecutable(bootstrapPath);

    fs.rmSync(outputPath, { force: true });
    run(go, [
      ...packer,
      "append",
      "-stub", bootstrapPath,
      "-payload", payloadPath,
      "-output", outputPath,
      "-sha256", payloadHash
    ], { env: { ...process.env, GOTOOLCHAIN: "go1.20.14" } });
    run(go, [
      ...packer,
      "verify-executable",
      "-executable", outputPath,
      "-sha256", payloadHash,
      "-sing-box-sha256", expectedSingBoxHash
    ], { env: { ...process.env, GOTOOLCHAIN: "go1.20.14" } });
    verifyWindowsX64GuiExecutable(outputPath);
    console.log(`Single-file Windows x64 Choobs executable created: ${path.relative(root, outputPath)}`);
  } finally {
    cleanBuildOutputs();
  }
}

try {
  build();
} catch (error) {
  console.error(`Portable build failed: ${error.message}`);
  process.exitCode = 1;
}
