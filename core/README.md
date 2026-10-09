# Choobs Core

Choobs expects the sing-box executable in `core/bin/`. Do not commit the
executable and do not download it automatically.

For Windows x64, the expected path is:

```text
core/bin/sing-box.exe
```

The directory is intentionally empty in Git. x86 is not supported yet.

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

## Core Manager

The Electron main process starts `backend/choobs-core-manager[.exe]` using a
fixed application-relative path. The manager derives `core/bin/` from its own
location, accepts only the `start`, `stop`, `restart`, and `status` commands
over its private stdin/stdout JSON-lines channel, and launches sing-box with
`os/exec` (no shell). Renderer code cannot provide executable or config paths.

The manager writes its temporary config to the per-user
`<userData>/core/configs/runtime.json` and bounded stdout/stderr/lifecycle
output to `<userData>/core/logs/sing-box.log`, so a Windows install under
Program Files does not need write access to its installation directory.
Running the Go manager directly without this app-provided data directory uses
the sibling `core/configs/` and `core/logs/` directories. Runtime configs are
removed after disconnect; the log is capped at 2 MiB and starts over when full.
UUIDs and URI query values are redacted from logs.

## Current proxy mode

Choobs generates a sing-box `mixed` inbound on `127.0.0.1` and a dynamically
selected local port. This supports SOCKS5 and HTTP clients on the same
loopback-only endpoint; it does not listen on a network interface. Before
starting `run`, the manager runs `sing-box check -c <runtime config>`, waits
for the local listener, then attempts HTTPS public-IP checks through that
proxy using fallback endpoints. Only after a valid public IP is received does
the manager report `running` to Electron. Address, port, and verified exit IP
are returned in Core Manager status.

The desktop does not automatically change the Windows system proxy. To route
an application's connections, configure that application to use the reported
local SOCKS5/HTTP proxy address. Browser Preview intentionally remains demo
only.

Config generation supports VLESS over TCP with no security, TLS, or Reality
(Reality requires a valid public key and maps the documented short ID);
supported TLS parameters include SNI/serverName, ALPN and documented uTLS
fingerprints. Unsupported VLESS transports/parameters return an explicit
error. VMess, Trojan, Shadowsocks, and SOCKS5 subscription entries continue
to parse and display, but cannot yet be started by the Core Manager.

**Работающий процесс sing-box сам по себе не означает, что VPN-трафик работает.**
The successful proxied HTTPS/IP check verifies a connection through the
configured local proxy and selected sing-box route; it does not redirect all
Windows traffic or prove that every destination/application is reachable.
No TUN, system proxy, DNS interception, routing policy, kill switch, or
installer is implemented.

## Build and test

Build a Windows x64 portable package from the repository root with Node.js,
npm dependencies installed, and Go 1.20.14 available on `PATH`:

```sh
npm ci
go version
npm run build:win:portable
```

If a newer Go version is installed, Go's toolchain selector can fetch and use
the pinned compiler for this command:

```sh
GOTOOLCHAIN=go1.20.14 npm run build:win:portable
```

The build script verifies the pinned `core/bin/sing-box.exe` SHA-256, cross
compiles `backend/choobs-core-manager.exe` with `CGO_ENABLED=0`, `GOOS=windows`,
and `GOARCH=amd64`, then invokes electron-builder's Windows x64 directory
target. The Choobs ICO is configured as the Windows executable icon, and the
Go bootstrap embeds the same icon resource in the final single-file
`dist/Choobs.exe`. PNG and ICO assets are included in `app.asar` for the window
and tray at runtime. The script refuses to build unless `go version` reports
Go 1.20.14. The portable application includes the manager, sing-box, and
`core/configs/` under its resources directory; it does not create an installer.

```powershell
$env:GOTOOLCHAIN = "go1.20.14"
go version
npm ci
npm run build:win:portable
```

This pins Electron to 22.3.27 and electron-builder to 26.15.3. The package
target and architecture do not prove runtime compatibility on Windows 7; test
the resulting artifact on a Windows 7 x64 system before using it.

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
2. Confirm `core\bin\sing-box.exe` is the v1.10.7 legacy release build. Build
   `backend\choobs-core-manager.exe` with Go 1.20.14 using the commands above.
   Do not use Wine or a non-legacy sing-box build for this test.
3. Install the project dependencies and start the desktop app using the
   project's existing Electron 22.3.27 setup.
4. In Choobs, add a subscription you control, select a VLESS server using a
   supported TCP transport, then press **Connect**. Choobs loads the saved
   server by ID, generates the temporary config, runs `sing-box check`, starts
   the core, waits for the loopback listener, and checks HTTPS/IP through that
   proxy. It must not show **Connected** unless these checks all pass.
5. On success, the app reports the loopback proxy address/port and verified
   exit IP. The proxy is for applications explicitly configured to use it;
   this test does not route all Windows traffic.
6. Press **Disconnect** and confirm Choobs returns to **Not connected**. The
   runtime config should be removed; the bounded diagnostic log is retained
   at `<userData>\core\logs\sing-box.log` (normally
   `%APPDATA%\choobs\core\logs\sing-box.log` for this app identity).
7. If a check fails, note the short UI error and inspect that log. Do not
   share subscription URLs, VLESS URIs, UUIDs, or account credentials when
   reporting the issue. A missing/unsupported transport, core startup error,
   proxy timeout, and external HTTPS-check failure are distinct failure
   points; no successful process start alone counts as a connected test.
