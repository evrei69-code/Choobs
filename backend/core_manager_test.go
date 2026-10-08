package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testVLESSURI = "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=tls&sni=example.com#test"

type fakeProxyController struct {
	mu           sync.Mutex
	applied      bool
	applyError   error
	restoreError error
	applyCount   int
	restoreCount int
	recoverCount int
}

func (controller *fakeProxyController) Apply(port uint16) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.applyCount++
	if port == 0 {
		return errors.New("invalid port")
	}
	if controller.applyError != nil {
		return controller.applyError
	}
	controller.applied = true
	return nil
}

func (controller *fakeProxyController) Restore() error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	controller.restoreCount++
	if controller.restoreError != nil {
		return controller.restoreError
	}
	controller.applied = false
	return nil
}

func (controller *fakeProxyController) Recover() error {
	controller.mu.Lock()
	controller.recoverCount++
	controller.applied = false
	controller.mu.Unlock()
	return nil
}

func newTestCoreManager(paths ManagerPaths) *CoreManager {
	manager := NewCoreManager(paths)
	manager.SetProxyController(&fakeProxyController{})
	return manager
}

func testServer() ServerInput {
	return ServerInput{
		Name:     "test",
		Protocol: "VLESS",
		Address:  "example.com",
		Port:     443,
		URI:      testVLESSURI,
	}
}

func TestGenerateRuntimeConfigForBasicVLESS(t *testing.T) {
	contents, secrets, err := GenerateRuntimeConfig(testServer())
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(contents, &config); err != nil {
		t.Fatalf("generated config is not valid JSON: %v", err)
	}
	inbounds, ok := config["inbounds"].([]any)
	if !ok || len(inbounds) != 1 {
		t.Fatalf("expected one local proxy inbound, got %#v", config["inbounds"])
	}
	inbound := inbounds[0].(map[string]any)
	if inbound["type"] != "mixed" || inbound["listen"] != "127.0.0.1" || inbound["listen_port"] != float64(2080) {
		t.Fatalf("proxy inbound must bind loopback: %#v", inbound)
	}
	outbounds, ok := config["outbounds"].([]any)
	if !ok || len(outbounds) != 2 {
		t.Fatalf("expected VLESS and direct outbounds, got %#v", config["outbounds"])
	}
	proxy := outbounds[0].(map[string]any)
	if proxy["type"] != "vless" || proxy["uuid"] != "123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("unexpected VLESS outbound: %#v", proxy)
	}
	tls := proxy["tls"].(map[string]any)
	if tls["enabled"] != true || tls["server_name"] != "example.com" {
		t.Fatalf("unexpected TLS settings: %#v", tls)
	}
	if len(secrets) == 0 || secrets[0] != proxy["uuid"] {
		t.Fatalf("expected UUID to be marked for log redaction, got %#v", secrets)
	}
}

func TestGenerateRuntimeConfigWithoutTLS(t *testing.T) {
	server := testServer()
	server.URI = "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?encryption=none&type=tcp"
	contents, _, err := GenerateRuntimeConfig(server)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(contents, &config); err != nil {
		t.Fatal(err)
	}
	outbound := config["outbounds"].([]any)[0].(map[string]any)
	if _, hasTLS := outbound["tls"]; hasTLS {
		t.Fatalf("TLS should be omitted when the URI does not request it: %#v", outbound)
	}
}

func TestGenerateRuntimeConfigRejectsUnsupportedAndInvalidServer(t *testing.T) {
	server := testServer()
	server.Protocol = "VMess"
	if _, _, err := GenerateRuntimeConfig(server); err == nil {
		t.Fatal("expected unsupported protocol error")
	}

	server = testServer()
	server.URI = "vless://not-a-uuid@example.com:443"
	if _, _, err := GenerateRuntimeConfig(server); err == nil {
		t.Fatal("expected invalid UUID error")
	}

	server = testServer()
	server.Address = "different.example"
	if _, _, err := GenerateRuntimeConfig(server); err == nil {
		t.Fatal("expected server/URI mismatch error")
	}
}

func TestGenerateRuntimeConfigUsesDefaultVLESSPort(t *testing.T) {
	server := testServer()
	server.URI = "vless://123e4567-e89b-12d3-a456-426614174000@example.com?security=tls"
	contents, _, err := GenerateRuntimeConfig(server)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(contents, []byte(`"server_port": 443`)) {
		t.Fatalf("expected the parser's default VLESS port in config: %s", contents)
	}
}

func TestGenerateRuntimeConfigRejectsUnsupportedParametersAndPorts(t *testing.T) {
	server := testServer()
	server.Port = 65536
	if _, _, err := GenerateRuntimeConfig(server); err == nil {
		t.Fatal("expected invalid port error")
	}

	server = testServer()
	server.Address = "bad host"
	if _, _, err := GenerateRuntimeConfig(server); err == nil {
		t.Fatal("expected invalid host error")
	}

	server = testServer()
	server.URI = "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=tls&type=ws&host=example.com&path=%2F"
	if _, _, err := GenerateRuntimeConfig(server); err == nil {
		t.Fatal("expected unsupported transport error")
	}
}

func TestGenerateRuntimeConfigRejectsUnknownParametersWithoutEchoingValues(t *testing.T) {
	server := testServer()
	server.URI = "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=tls&token=secret-token"
	_, _, err := GenerateRuntimeConfig(server)
	if err == nil {
		t.Fatal("expected unsupported VLESS parameter error")
	}
	if !strings.Contains(err.Error(), "Unsupported VLESS parameter: token") {
		t.Fatalf("unexpected unsupported-parameter error: %v", err)
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("unsupported-parameter error exposed its value: %v", err)
	}
}

func TestGenerateRuntimeConfigMapsVLESSRealityAndTLSOptions(t *testing.T) {
	server := testServer()
	server.URI = "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=reality&sni=front.example&publicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&shortId=abcd&fp=chrome&alpn=h2%2Chttp%2F1.1&flow=xtls-rprx-vision"
	contents, _, err := GenerateRuntimeConfig(server, 34567)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(contents, &config); err != nil {
		t.Fatal(err)
	}
	inbound := config["inbounds"].([]any)[0].(map[string]any)
	if inbound["listen_port"] != float64(34567) || inbound["listen"] != "127.0.0.1" {
		t.Fatalf("runtime proxy did not use selected loopback port: %#v", inbound)
	}
	outbound := config["outbounds"].([]any)[0].(map[string]any)
	if outbound["flow"] != "xtls-rprx-vision" {
		t.Fatalf("flow was not mapped: %#v", outbound)
	}
	tls := outbound["tls"].(map[string]any)
	if tls["server_name"] != "front.example" {
		t.Fatalf("SNI was not mapped: %#v", tls)
	}
	if tls["reality"].(map[string]any)["public_key"] != "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("Reality key was not mapped: %#v", tls["reality"])
	}
	if tls["utls"].(map[string]any)["fingerprint"] != "chrome" {
		t.Fatalf("uTLS fingerprint was not mapped: %#v", tls["utls"])
	}
	if !bytes.Contains(contents, []byte(`"alpn": [`)) {
		t.Fatalf("ALPN was not mapped: %s", contents)
	}
}

func TestGenerateRuntimeConfigMapsStandardVLESSRealityParameters(t *testing.T) {
	server := testServer()
	server.URI = "vless://11111111-2222-4333-8444-555555555555@example.com:443?encryption=none&security=reality&type=tcp&headerType=none&sni=front%2Eexample&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D&sid=%61bcd&fp=chrome&flow=xtls-rprx-vision"

	contents, _, err := GenerateRuntimeConfig(server)
	if err != nil {
		t.Fatalf("standard VLESS Reality parameters were rejected: %v", err)
	}

	var config map[string]any
	if err := json.Unmarshal(contents, &config); err != nil {
		t.Fatalf("generated config is not valid JSON: %v", err)
	}
	outbound := config["outbounds"].([]any)[0].(map[string]any)
	if outbound["flow"] != "xtls-rprx-vision" {
		t.Fatalf("Reality flow was not mapped: %#v", outbound)
	}
	tls, ok := outbound["tls"].(map[string]any)
	if !ok || tls["enabled"] != true || tls["server_name"] != "front.example" {
		t.Fatalf("Reality TLS/SNI settings were not mapped: %#v", outbound["tls"])
	}
	reality, ok := tls["reality"].(map[string]any)
	if !ok || reality["enabled"] != true ||
		reality["public_key"] != "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" ||
		reality["short_id"] != "abcd" {
		t.Fatalf("standard pbk/sid were not mapped to sing-box Reality fields: %#v", tls["reality"])
	}
	utls, ok := tls["utls"].(map[string]any)
	if !ok || utls["enabled"] != true || utls["fingerprint"] != "chrome" {
		t.Fatalf("Reality fingerprint was not mapped: %#v", tls["utls"])
	}
}

func TestGenerateRuntimeConfigRejectsUnsupportedVLESSHeaderType(t *testing.T) {
	server := testServer()
	server.URI = "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=reality&type=tcp&headerType=http&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd"
	if _, _, err := GenerateRuntimeConfig(server); err == nil || !strings.Contains(err.Error(), "VLESS header type") {
		t.Fatalf("unsupported VLESS header type should be rejected: %v", err)
	}
}

func TestGenerateRuntimeConfigRejectsConflictingRealityAliases(t *testing.T) {
	server := testServer()
	server.URI = "vless://11111111-2222-4333-8444-555555555555@example.com:443?security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&publicKey=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&sid=abcd"
	if _, _, err := GenerateRuntimeConfig(server); err == nil || !strings.Contains(err.Error(), `"pbk" and "publicKey" conflict`) {
		t.Fatalf("conflicting public key aliases should be rejected without precedence: %v", err)
	}
}

func TestCoreManagerLocalProxyListenerLifecycle(t *testing.T) {
	root := t.TempDir()
	paths := ManagerPaths{
		SingBoxExecutable: os.Args[0],
		ConfigFile:        filepath.Join(root, "configs", "runtime.json"),
		LogFile:           filepath.Join(root, "logs", "sing-box.log"),
	}
	manager := newTestCoreManager(paths)
	proxyController := manager.proxyController.(*fakeProxyController)
	manager.commandArgs = []string{"-test.run=TestCoreManagerHelperProcess"}
	manager.commandEnv = append(os.Environ(),
		"CHOOBS_CORE_MANAGER_HELPER=proxy",
		"CHOOBS_CORE_HELPER_CONFIG="+paths.ConfigFile,
	)
	manager.checkProxy = func(port uint16) (string, error) {
		return "203.0.113.1", nil
	}

	started := manager.Start(testServer())
	if started.State != "running" || !started.Running || started.PID == nil || started.ProxyPort == 0 {
		t.Fatalf("manager did not become running after listener became available: %#v", started)
	}
	if proxyController.applyCount != 1 {
		t.Fatalf("system proxy should be applied once after readiness, got %d", proxyController.applyCount)
	}
	proxyAddress := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(started.ProxyPort)))
	connection, err := net.DialTimeout("tcp", proxyAddress, 250*time.Millisecond)
	if err != nil {
		t.Fatalf("expected local proxy listener at %s: %v", proxyAddress, err)
	}
	_ = connection.Close()

	duplicate := manager.Start(testServer())
	if duplicate.PID == nil || *duplicate.PID != *started.PID || duplicate.ProxyPort != started.ProxyPort {
		t.Fatalf("duplicate start created a different process or listener: %#v", duplicate)
	}

	stopped := manager.Stop()
	if stopped.State != "stopped" || stopped.Running || stopped.PID != nil {
		t.Fatalf("manager did not stop cleanly: %#v", stopped)
	}
	if proxyController.restoreCount < 1 {
		t.Fatal("system proxy was not restored during disconnect")
	}
	if err := waitForProxyShutdown(started.ProxyPort); err != nil {
		t.Fatalf("local listener remained open after stop: %v", err)
	}
	if _, err := os.Stat(paths.ConfigFile); !os.IsNotExist(err) {
		t.Fatalf("runtime config remains after stop: %v", err)
	}

	restarted := manager.Restart(nil)
	if restarted.State != "running" || !restarted.Running || restarted.PID == nil {
		t.Fatalf("manager did not restart: %#v", restarted)
	}
	stopped = manager.Stop()
	if stopped.State != "stopped" || stopped.Running {
		t.Fatalf("manager did not stop after restart: %#v", stopped)
	}
	if err := waitForProxyShutdown(restarted.ProxyPort); err != nil {
		t.Fatalf("restarted listener remained open after stop: %v", err)
	}
}

func TestCoreManagerStartStopRestart(t *testing.T) {
	root := t.TempDir()
	paths := ManagerPaths{
		SingBoxExecutable: os.Args[0],
		ConfigFile:        filepath.Join(root, "configs", "runtime.json"),
		LogFile:           filepath.Join(root, "logs", "sing-box.log"),
	}
	manager := newTestCoreManager(paths)
	manager.commandArgs = []string{"-test.run=TestCoreManagerHelperProcess"}
	manager.commandEnv = append(os.Environ(), "CHOOBS_CORE_MANAGER_HELPER=wait", "CHOOBS_CORE_HELPER_SECRET=123e4567-e89b-12d3-a456-426614174000")
	manager.proxyReady = func(port uint16) bool { return port > 0 }
	manager.checkProxy = func(port uint16) (string, error) { return "203.0.113.1", nil }

	started := manager.Start(testServer())
	if !started.Running || started.State != "running" || started.PID == nil {
		t.Fatalf("unexpected start status: %#v", started)
	}
	config, err := os.ReadFile(paths.ConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(config) || !bytes.Contains(config, []byte("123e4567-e89b-12d3-a456-426614174000")) {
		t.Fatalf("runtime config was not written: %s", config)
	}
	if !bytes.Contains(config, []byte(`"listen": "127.0.0.1"`)) {
		t.Fatalf("runtime config proxy is not loopback-only: %s", config)
	}
	duplicate := manager.Start(testServer())
	if duplicate.PID == nil || *duplicate.PID != *started.PID || duplicate.ExternalIP != "203.0.113.1" {
		t.Fatalf("duplicate start did not return existing verified process: %#v", duplicate)
	}

	waitForLog(t, paths.LogFile, "[REDACTED]")
	log, err := os.ReadFile(paths.LogFile)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(log, []byte("123e4567")) || !bytes.Contains(log, []byte("[REDACTED]")) {
		t.Fatalf("sensitive child output was not redacted: %s", log)
	}

	stopped := manager.Stop()
	if stopped.Running || stopped.PID != nil || stopped.State != "stopped" {
		t.Fatalf("unexpected stop status: %#v", stopped)
	}

	restarted := manager.Restart(nil)
	if !restarted.Running || restarted.State != "running" {
		t.Fatalf("unexpected restart status: %#v", restarted)
	}
	stopped = manager.Stop()
	if stopped.State != "stopped" {
		t.Fatalf("manager did not stop after restart: %#v", stopped)
	}
	if _, err := os.Stat(paths.ConfigFile); !os.IsNotExist(err) {
		t.Fatalf("runtime config was not deleted after stop: %v", err)
	}
}

func TestCoreManagerMissingBinaryReturnsErrorStatus(t *testing.T) {
	root := t.TempDir()
	manager := newTestCoreManager(ManagerPaths{
		SingBoxExecutable: filepath.Join(root, "missing-sing-box"),
		ConfigFile:        filepath.Join(root, "runtime.json"),
		LogFile:           filepath.Join(root, "sing-box.log"),
	})
	status := manager.Start(testServer())
	if status.Running || status.State != "error" || status.PID != nil || status.ErrorCode != "CORE_NOT_FOUND" || !strings.Contains(status.Error, "VPN core not found") {
		t.Fatalf("unexpected missing binary status: %#v", status)
	}
}

func TestCoreManagerUnexpectedProcessExit(t *testing.T) {
	root := t.TempDir()
	manager := newTestCoreManager(ManagerPaths{
		SingBoxExecutable: os.Args[0],
		ConfigFile:        filepath.Join(root, "runtime.json"),
		LogFile:           filepath.Join(root, "sing-box.log"),
	})
	manager.commandArgs = []string{"-test.run=TestCoreManagerHelperProcess"}
	manager.commandEnv = append(os.Environ(), "CHOOBS_CORE_MANAGER_HELPER=exit")
	manager.proxyReady = func(port uint16) bool { return true }
	manager.checkProxy = func(port uint16) (string, error) { return "203.0.113.1", nil }
	status := manager.Start(testServer())
	if status.State != "running" && status.State != "stopped" && status.State != "error" {
		t.Fatalf("unexpected status for an exiting process: %#v", status)
	}
	if status.Running != (status.State == "running") {
		t.Fatalf("inconsistent process status: %#v", status)
	}
	waitForState(t, manager, "error")
	if status := manager.Status(); status.ErrorCode != "CORE_EXITED" {
		t.Fatalf("unexpected process-exit status: %#v", status)
	}
}

func TestInvalidConfigPreventsCoreStartAndRedactsDiagnostics(t *testing.T) {
	root := t.TempDir()
	paths := ManagerPaths{
		SingBoxExecutable: os.Args[0],
		ConfigFile:        filepath.Join(root, "runtime.json"),
		LogFile:           filepath.Join(root, "sing-box.log"),
	}
	manager := NewCoreManager(paths)
	manager.commandArgs = []string{"-test.run=TestCoreManagerHelperProcess"}
	manager.validateConfig = func(_ string, _ []string, output *boundedLogWriter) error {
		_, _ = output.Write([]byte("diagnostic includes uuid 123e4567-e89b-12d3-a456-426614174000"))
		return errors.New("sensitive config diagnostic")
	}
	status := manager.Start(testServer())
	if status.State != "error" || status.ErrorCode != "CONFIG_INVALID" || status.Running || status.PID != nil {
		t.Fatalf("unexpected invalid-config status: %#v", status)
	}
	if _, err := os.Stat(paths.ConfigFile); !os.IsNotExist(err) {
		t.Fatalf("invalid runtime config was not removed: %v", err)
	}
	log, err := os.ReadFile(paths.LogFile)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(log, []byte("123e4567-e89b-12d3-a456-426614174000")) || !bytes.Contains(log, []byte("[REDACTED]")) {
		t.Fatalf("validation log leaked VLESS UUID: %s", log)
	}
}

func TestProxyConnectivityFailureStopsProcessAndDoesNotReportRunning(t *testing.T) {
	root := t.TempDir()
	manager := newTestCoreManager(ManagerPaths{
		SingBoxExecutable: os.Args[0],
		ConfigFile:        filepath.Join(root, "runtime.json"),
		LogFile:           filepath.Join(root, "sing-box.log"),
	})
	manager.commandArgs = []string{"-test.run=TestCoreManagerHelperProcess"}
	manager.commandEnv = append(os.Environ(), "CHOOBS_CORE_MANAGER_HELPER=wait")
	manager.proxyReady = func(port uint16) bool { return true }
	manager.checkProxy = func(port uint16) (string, error) { return "", errors.New("offline") }
	status := manager.Start(testServer())
	if status.State != "error" || status.Running || status.ErrorCode != "CONNECTIVITY_FAILED" || status.PID != nil {
		t.Fatalf("connectivity failure was reported as connected: %#v", status)
	}
	waitForState(t, manager, "error")
	controller := manager.proxyController.(*fakeProxyController)
	if controller.applyCount != 0 || controller.restoreCount == 0 {
		t.Fatalf("system proxy should not be applied before outbound validation: %#v", controller)
	}
}

func TestCoreManagerKeepsCoreAliveWhenProxyRestoreFails(t *testing.T) {
	root := t.TempDir()
	manager := NewCoreManager(ManagerPaths{
		SingBoxExecutable: os.Args[0],
		ConfigFile:        filepath.Join(root, "runtime.json"),
		LogFile:           filepath.Join(root, "sing-box.log"),
	})
	controller := &fakeProxyController{
		applyError:   errors.New("simulated apply failure"),
		restoreError: errors.New("simulated restore failure"),
	}
	manager.SetProxyController(controller)
	manager.commandArgs = []string{"-test.run=TestCoreManagerHelperProcess"}
	manager.commandEnv = append(os.Environ(), "CHOOBS_CORE_MANAGER_HELPER=wait")
	manager.proxyReady = func(port uint16) bool { return true }
	manager.checkProxy = func(port uint16) (string, error) { return "203.0.113.1", nil }

	status := manager.Start(testServer())
	if status.State != "error" || status.ErrorCode != "PROXY_RESTORE_FAILED" || !status.Running || status.PID == nil {
		t.Fatalf("core must remain running when proxy restoration fails: %#v", status)
	}

	controller.mu.Lock()
	controller.restoreError = nil
	controller.mu.Unlock()
	status = manager.Stop()
	if status.State != "stopped" || status.Running {
		t.Fatalf("core did not stop after proxy restoration became available: %#v", status)
	}
}

func TestCoreManagerServiceAcceptsOnlyKnownCommands(t *testing.T) {
	manager := NewCoreManager(ManagerPaths{})
	var output bytes.Buffer
	if err := serve(strings.NewReader("{\"id\":\"1\",\"command\":\"not-a-command\"}\n"), &output, manager); err != nil {
		t.Fatal(err)
	}
	var response managerResponse
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.ID != "1" || response.Status.State != "error" || response.Status.Running {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestCoreManagerServiceRejectsRendererExecutablePath(t *testing.T) {
	manager := NewCoreManager(ManagerPaths{})
	var output bytes.Buffer
	input := `{"id":"1","command":"start","server":{"protocol":"VLESS","address":"example.com","port":443,"uri":"vless://123e4567-e89b-12d3-a456-426614174000@example.com:443"},"executablePath":"/tmp/attacker"}`
	if err := serve(strings.NewReader(input+"\n"), &output, manager); err != nil {
		t.Fatal(err)
	}
	var response managerResponse
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status.State != "error" || response.Status.Running || manager.command != nil {
		t.Fatalf("unexpected response to arbitrary executable path: %#v", response)
	}
}

func TestCoreLogNeverExceedsConfiguredLimit(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "sing-box.log")
	if err := os.WriteFile(filePath, bytes.Repeat([]byte("x"), int(maximumLogBytes-4)), 0600); err != nil {
		t.Fatal(err)
	}
	file, remaining, err := openCoreLog(filePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := &boundedLogWriter{file: file, remaining: remaining}
	if _, err := writer.Write([]byte("12345678")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != maximumLogBytes {
		t.Fatalf("log size is %d, expected no more than %d", info.Size(), maximumLogBytes)
	}
}

func TestLogRedactionHandlesSecretsSplitAcrossWrites(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "sing-box.log")
	file, remaining, err := openCoreLog(filePath)
	if err != nil {
		t.Fatal(err)
	}
	logger := &boundedLogWriter{file: file, remaining: remaining, secrets: []string{"uuid-secret"}}
	prefixed := &prefixedLogWriter{writer: logger, prefix: "[stderr] "}
	if _, err := prefixed.Write([]byte("remote said uuid-se")); err != nil {
		t.Fatal(err)
	}
	if _, err := prefixed.Write([]byte("cret\n")); err != nil {
		t.Fatal(err)
	}
	if err := prefixed.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := logger.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(contents, []byte("uuid-secret")) || !bytes.Contains(contents, []byte("[REDACTED]")) {
		t.Fatalf("split secret was not redacted: %s", contents)
	}
}

func TestCoreLogRedactsFullVLESSURI(t *testing.T) {
	server := testServer()
	_, secrets, err := GenerateRuntimeConfig(server)
	if err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(t.TempDir(), "sing-box.log")
	file, remaining, err := openCoreLog(filePath)
	if err != nil {
		t.Fatal(err)
	}
	logger := &boundedLogWriter{file: file, remaining: remaining, secrets: secrets}
	if _, err := logger.Write([]byte("diagnostic " + server.URI + "\n")); err != nil {
		t.Fatal(err)
	}
	if err := logger.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(contents, []byte(server.URI)) || !bytes.Contains(contents, []byte("[REDACTED]")) {
		t.Fatalf("full VLESS URI was not redacted: %s", contents)
	}
}

func TestStoppedStatusSerializesNullPID(t *testing.T) {
	encoded, err := json.Marshal(NewCoreManager(ManagerPaths{}).Status())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"pid":null`)) || !bytes.Contains(encoded, []byte(`"state":"stopped"`)) {
		t.Fatalf("unexpected stopped status JSON: %s", encoded)
	}
}

func TestApplicationManagerPathsAreApplicationControlled(t *testing.T) {
	root := t.TempDir()
	executablePath := filepath.Join(root, "backend", "choobs-core-manager.exe")
	dataDirectory := filepath.Join(root, "user-data")
	t.Setenv("CHOOBS_DATA_DIRECTORY", dataDirectory)
	manager, err := newApplicationManager(executablePath)
	if err != nil {
		t.Fatal(err)
	}
	executableName := "sing-box"
	if runtime.GOOS == "windows" {
		executableName += ".exe"
	}
	if manager.paths.SingBoxExecutable != filepath.Join(root, "core", "bin", executableName) {
		t.Fatalf("unexpected sing-box path: %s", manager.paths.SingBoxExecutable)
	}
	if manager.paths.ConfigFile != filepath.Join(dataDirectory, "core", "configs", "runtime.json") {
		t.Fatalf("unexpected runtime config path: %s", manager.paths.ConfigFile)
	}
	if manager.paths.LogFile != filepath.Join(dataDirectory, "core", "logs", "sing-box.log") {
		t.Fatalf("unexpected log path: %s", manager.paths.LogFile)
	}
	if manager.paths.ProxyStateFile != filepath.Join(dataDirectory, "system-proxy-session.json") {
		t.Fatalf("unexpected proxy recovery path: %s", manager.paths.ProxyStateFile)
	}
	t.Setenv("CHOOBS_DATA_DIRECTORY", "relative-path")
	if _, err := newApplicationManager(executablePath); err == nil {
		t.Fatal("expected relative data directory to be rejected")
	}
}

func TestCoreManagerHelperProcess(t *testing.T) {
	mode := os.Getenv("CHOOBS_CORE_MANAGER_HELPER")
	if mode == "" {
		return
	}
	if secret := os.Getenv("CHOOBS_CORE_HELPER_SECRET"); secret != "" {
		_, _ = os.Stdout.WriteString("helper output " + secret + "\n")
	}
	if mode == "wait" {
		time.Sleep(30 * time.Second)
	}
	if mode == "proxy" {
		configPath := os.Getenv("CHOOBS_CORE_HELPER_CONFIG")
		configContents, err := os.ReadFile(configPath)
		if err != nil {
			os.Exit(1)
		}
		var config struct {
			Inbounds []struct {
				Listen     string `json:"listen"`
				ListenPort uint16 `json:"listen_port"`
			} `json:"inbounds"`
		}
		if json.Unmarshal(configContents, &config) != nil || len(config.Inbounds) != 1 {
			os.Exit(1)
		}
		listener, err := net.Listen("tcp", net.JoinHostPort(config.Inbounds[0].Listen, strconv.Itoa(int(config.Inbounds[0].ListenPort))))
		if err != nil {
			os.Exit(1)
		}
		defer listener.Close()
		time.Sleep(30 * time.Second)
	}
	os.Exit(0)
}

func waitForLog(t *testing.T, filePath, text string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		contents, err := os.ReadFile(filePath)
		if err == nil && strings.Contains(string(contents), text) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("log did not contain %q", text)
}

func waitForState(t *testing.T, manager *CoreManager, state string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if manager.Status().State == state {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("manager did not reach state %q; got %#v", state, manager.Status())
}
