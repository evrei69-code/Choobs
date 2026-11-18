# Choobs Core

Choobs expects the sing-box and Xray executables in `core/bin/`. Runtime
binaries are ignored by Git and are not downloaded automatically.

For Windows x64, the expected path is:

```text
core/bin/sing-box.exe
core/bin/xray.exe
```

Only Windows x64 core binaries are supported.

## Recommended sing-box version

Use sing-box **v1.10.7**, pinned to the official
[v1.10.7 release](https://github.com/SagerNet/sing-box/releases/tag/v1.10.7).
Its [module file](https://proxy.golang.org/github.com/sagernet/sing-box/@v/v1.10.7.mod)
declares Go 1.20. Go's [Go 1.20 release notes](https://go.dev/doc/go1.20#ports)
state that Go 1.20 is the last Go release that runs on Windows 7; Go 1.21
requires Windows 10 or later. The release's [official build workflow](https://raw.githubusercontent.com/SagerNet/sing-box/v1.10.7/.github/workflows/build.yml)
marks `windows_amd64` as requiring legacy Go and installs Go 1.20.14. Build
both Choobs' manager and, if building sing-box from source, sing-box v1.10.7
with Go 1.20.14 for the legacy target.

Use the official `sing-box-1.10.7-windows-amd64-legacy.zip` release asset,
not the standard Windows amd64 archive. `core/bin/sing-box.exe` is the
v1.10.7 Go 1.20.14 legacy build. This is the upstream Windows 7 compatibility
target, not a guarantee: validate the exact binary and Choobs app on Windows 7
before distributing them.

## Recommended Xray version

Use the official Xray **v24.11.30** `Xray-win7-64.zip` release asset. Verify
the archive against its official `.dgst` file before extracting it:

```text
Archive SHA-256: ec1fb5790c556c6490a69354fe1d6f9056db1d068d4d565d2ef10fcbb882ddd2
Executable SHA-256: 15dc41c5f4f634848deb4e54cf242451cb4de0e0a2fed4c0d0657ecaa2333c53
```

Place the verified `xray.exe` at `core/bin/xray.exe`. The archive also contains
`wxray.exe`, `geoip.dat`, and `geosite.dat`; the current generated config uses
neither the GUI executable nor GeoIP/GeoSite rules. The version and hashes are
pinned in `backend/core-hashes.json`, checked by the build scripts, and the
Core Manager rechecks the Xray executable before starting it. Choobs does not
download Xray at runtime.

## Core Manager

The Electron main process starts `backend/choobs-core-manager[.exe]` using a
fixed application-relative path. The manager derives `core/bin/` from its own
location, accepts only the `start`, `stop`, `restart`, and `status` commands
over its private stdin/stdout JSON-lines channel, and launches the selected
sing-box or Xray executable with `os/exec` (no shell). Renderer code cannot
provide executable or config paths.

The manager writes its temporary config to the per-user
`<userData>/core/configs/runtime.json` and bounded stdout/stderr/lifecycle
output to `<userData>/core/logs/sing-box.log` or
`<userData>/core/logs/xray.log`, so a Windows install under Program Files does
not need write access to its installation directory.
Running the Go manager directly without this app-provided data directory uses
the sibling `core/configs/` and `core/logs/` directories. Runtime configs are
removed after disconnect; the log is capped at 2 MiB and starts over when full.
UUIDs and URI query values are redacted from logs.

## Current proxy mode

Choobs creates a loopback-only local proxy on a dynamically selected port.
sing-box uses a `mixed` inbound; Xray uses an HTTP inbound with HTTP CONNECT
support. Before starting a core, the manager validates its config with that
core's own command, waits for the local listener, then attempts HTTPS public-IP
checks through the proxy using fallback endpoints. Only after a valid public
IP is received does the manager apply the Windows System Proxy and report
`running` to Electron. Previous Windows proxy settings are restored on
disconnect or process exit. Address, port, and verified exit IP are returned
in Core Manager status.

The Windows System Proxy is applied automatically after connectivity checks.
The local proxy is bound to `127.0.0.1`; it does not listen on a network
interface. Browser Preview intentionally remains demo only.

Config generation supports VLESS over TCP with no security, TLS, or Reality
(Reality requires a valid public key and maps the documented short ID);
supported TLS parameters include SNI/serverName, ALPN and documented uTLS
fingerprints. Supported XHTTP and gRPC VLESS profiles use Xray; unsupported
combinations are rejected without changing transport or falling back to
another core. VMess, Trojan, Shadowsocks, and SOCKS5 subscription entries
continue to parse and display, but cannot yet be started by the Core Manager.

**Работающий процесс sing-box сам по себе не означает, что VPN-трафик работает.**
The successful proxied HTTPS/IP check verifies a connection through the
configured local proxy and selected core route; it does not redirect all
Windows traffic or prove that every destination/application is reachable.
No TUN, DNS interception, routing policy, or kill switch is implemented.

## Windows build and test

The Windows x64 NSIS installer and the portable executable both require Node.js,
npm dependencies, and Go 1.20.14 on `PATH`. The installer command is:

```sh
npm ci
go version
npm run build:win
```

On Linux, NSIS creation also requires Wine on `PATH`; building on Windows does
not require Wine.

If a newer Go version is installed, use Go's toolchain selector to use the
pinned legacy compiler:

```sh
GOTOOLCHAIN=go1.20.14 npm run build:win
GOTOOLCHAIN=go1.20.14 npm run build:portable
```

The installer is written to `dist/Choobs-0.1.0-Setup.exe`. It installs for the
current user and creates `Choobs` shortcuts in the Start Menu and on the
Desktop. The NSIS uninstaller removes these shortcuts and keeps user data.
The app executable and installer use `build/choobs.ico`.

Build the single-file portable version with:

```sh
npm run build:portable
```

The portable executable is written to `dist/Choobs.exe`. It can be copied to a
folder and launched with a double click; on first launch it extracts its
runtime to the current user's local application data directory. To create a
shortcut manually, right-click `Choobs.exe`, choose **Create shortcut**, and
move the shortcut to the Desktop. The portable build embeds the icon in both
the Electron app and its Go launcher.

Both build commands compile `backend/choobs-core-manager.exe` with
`CGO_ENABLED=0`, `GOOS=windows`, and `GOARCH=amd64`. Both build scripts verify
the pinned sing-box and Xray SHA-256 values before packaging; the portable
builder also checks the packaged Xray hash and embeds it into its verified
runtime. PNG and ICO assets are unpacked next to `app.asar` so Electron's
native window and tray icon loaders can read them from the packaged app.

```powershell
$env:GOTOOLCHAIN = "go1.20.14"
go version
npm ci
npm run build:win
```

Electron is pinned to 22.3.27 and electron-builder to 26.15.3. The package
target and architecture do not prove runtime compatibility on Windows 7; test
the installer and resulting app on a Windows 7 x64 system before distribution.

To build the manager for the current OS for development:

```sh
go build -o choobs-core-manager .
```

Unit tests do not require sing-box:

```sh
cd backend
go test ./...
```

The real integration test requires both the binary and a user-provided VLESS
test server; it is skipped when either is missing. Supply these environment
variables without committing them or sharing their values:

```sh
export CHOOBS_TEST_VLESS_HOST=example.net
export CHOOBS_TEST_VLESS_PORT=443
export CHOOBS_TEST_VLESS_URI='vless://<uuid>@example.net:443?security=tls&sni=example.net'
cd backend
go test -tags=integration -v ./...
```

The test validates the config with sing-box, starts the core, waits for the
loopback proxy and proxied HTTPS public-IP check, then stops and verifies the
process. Never use a real account URI in shell history on a shared machine.

## First end-to-end test on Windows 7 x64

1. Use a Windows 7 x64 computer or VM. Copy the Choobs project folder to a
   writable location such as `C:\Choobs`; do not place writable app data under
   `Program Files`.
2. Confirm `core\bin\sing-box.exe` is the v1.10.7 legacy release build and
   `core\bin\xray.exe` matches the pinned Xray v24.11.30 checksum. Build
   `backend\choobs-core-manager.exe` with Go 1.20.14 using the commands above.
   Do not use Wine or a non-legacy sing-box build for this test.
3. Install the project dependencies and start the desktop app using the
   project's existing Electron 22.3.27 setup.
4. In Choobs, add a subscription you control, select a VLESS server using a
   supported TCP transport, then press **Connect**. Choobs loads the saved
   server by ID, generates the temporary config, runs the selected core's
   config check, starts that core, waits for the loopback listener, and checks
   HTTPS/IP through that proxy. It must not show **Connected** unless these
   checks all pass. Test an XHTTP or supported gRPC profile separately to
   exercise Xray.
5. On success, the app reports the loopback proxy address/port and verified
   exit IP. The proxy is for applications explicitly configured to use it;
   this test does not route all Windows traffic.
6. Press **Disconnect** and confirm Choobs returns to **Not connected**. The
   runtime config should be removed; the bounded diagnostic log is retained
   at `<userData>\core\logs\<core>.log` (normally
   `%APPDATA%\choobs\core\logs\<core>.log` for this app identity).
7. If a check fails, note the short UI error and inspect that log. Do not
   share subscription URLs, VLESS URIs, UUIDs, or account credentials when
   reporting the issue. A missing/unsupported transport, core startup error,
   proxy timeout, and external HTTPS-check failure are distinct failure
   points; no successful process start alone counts as a connected test.
