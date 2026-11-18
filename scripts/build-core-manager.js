const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backend = path.join(root, "backend");
const outputName = process.platform === "win32" ? "choobs-core-manager.exe" : "choobs-core-manager";
const outputPath = path.join(backend, outputName);
const goos = {
  win32: "windows",
  darwin: "darwin",
  linux: "linux"
}[process.platform];
const goarch = {
  x64: "amd64",
  arm64: "arm64",
  ia32: "386"
}[process.arch];

function build() {
  if (!goos || !goarch) {
    throw new Error(`Development Core Manager build is unsupported on ${process.platform}/${process.arch}.`);
  }
  const result = spawnSync("go", [
    "build",
    "-C", backend,
    "-trimpath",
    "-ldflags=-s -w",
    "-o", outputPath,
    "."
  ], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: goos,
      GOARCH: goarch,
      GOPROXY: "off"
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Go Core Manager build failed with exit code ${result.status}.`);
}

try {
  build();
} catch (error) {
  console.error(`Development Core Manager build failed: ${error.message}`);
  process.exitCode = 1;
}
