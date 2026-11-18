const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const packageConfig = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const coreHashes = JSON.parse(fs.readFileSync(path.join(root, "backend", "core-hashes.json"), "utf8"));
const installerScript = fs.readFileSync(path.join(root, "scripts", "build-installer.js"), "utf8");
const portableScript = fs.readFileSync(path.join(root, "scripts", "build-portable.js"), "utf8");
const developmentBuildScript = fs.readFileSync(path.join(root, "scripts", "build-core-manager.js"), "utf8");
const windowsWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "windows-build.yml"), "utf8");

test("Electron packages both cores outside asar at the paths used by Core Manager", () => {
  const resources = packageConfig.build.extraResources;
  for (const executable of ["sing-box.exe", "xray.exe"]) {
    assert.ok(resources.some((resource) =>
      resource.from === `core/bin/${executable}` &&
      resource.to === `core/bin/${executable}`
    ), `${executable} must be copied to resources/core/bin`);
  }
  assert.ok(resources.some((resource) =>
    resource.from === "backend/core-hashes.json" &&
    resource.to === "backend/core-hashes.json"
  ), "core-hashes.json must be copied to resources/backend");
});

test("Xray release metadata pins the verified Win7 x64 archive and executable", () => {
  assert.equal(coreHashes.xray.version, "24.11.30");
  assert.equal(coreHashes.xray.releaseUrl,
    "https://github.com/XTLS/Xray-core/releases/download/v24.11.30/Xray-win7-64.zip");
  assert.equal(coreHashes.xray.archiveSha256,
    "ec1fb5790c556c6490a69354fe1d6f9056db1d068d4d565d2ef10fcbb882ddd2");
  assert.equal(coreHashes.xray.sha256,
    "15dc41c5f4f634848deb4e54cf242451cb4de0e0a2fed4c0d0657ecaa2333c53");
});

test("installer and portable builders enforce the pinned Xray executable hash", () => {
  for (const script of [installerScript, portableScript]) {
    assert.match(script, /coreHashes\.xray\.sha256/);
    assert.match(script, /expectedXrayHash/);
    assert.match(script, /core\/bin\/xray\.exe/);
    assert.match(script, /packagedXrayHash/);
  }
  assert.match(portableScript, /-xray-sha256/);
  assert.match(portableScript, /expectedXraySHA256/);
  for (const script of [installerScript, portableScript]) {
    assert.match(script, /packagedCoreHashesPath/);
    assert.match(script, /Packaged core hash manifest/);
    assert.match(script, /choobs-core-manager\.exe/);
    assert.match(script, /sing-box\.exe/);
  }
});

test("Installer and Portable electron-builder invocations disable publishing", () => {
  for (const script of [installerScript, portableScript]) {
    assert.match(script, /"--publish",\s*"never"/);
  }
});

test("npm start rebuilds the Core Manager locally before launching Electron", () => {
  assert.equal(packageConfig.scripts.prestart, "node scripts/build-core-manager.js");
  assert.match(developmentBuildScript, /spawnSync\(["']go["']/);
  assert.match(developmentBuildScript, /"build",\s*"-C", backend/);
  assert.match(developmentBuildScript, /choobs-core-manager/);
  assert.match(developmentBuildScript, /GOPROXY:\s*["']off["']/);
});

test("Windows CI builds both artifacts with pinned toolchains and verified cores", () => {
  assert.match(windowsWorkflow, /runs-on:\s*windows-latest/);
  assert.match(windowsWorkflow, /node-version:\s*22\.12\.0/);
  assert.match(windowsWorkflow, /go-version:\s*1\.20\.14/);
  assert.match(windowsWorkflow, /npm run build:win/);
  assert.match(windowsWorkflow, /npm run build:portable/);
  assert.match(windowsWorkflow, /actions\/upload-artifact@v4/);
  assert.match(windowsWorkflow, /core-hashes\.json/);
  assert.match(windowsWorkflow, /Get-FileHash/);
  assert.match(windowsWorkflow, /windows-amd64-legacy\.zip/);
  assert.match(windowsWorkflow, /Xray-win7-64\.zip/);
});
