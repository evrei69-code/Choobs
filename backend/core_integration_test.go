//go:build integration

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

func TestRealSingBoxStartStop(t *testing.T) {
	applicationDirectory, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	executableName := "sing-box"
	if runtime.GOOS == "windows" {
		executableName += ".exe"
	}
	singBoxPath := filepath.Join(applicationDirectory, "core", "bin", executableName)
	if _, err := os.Stat(singBoxPath); err != nil {
		t.Skipf("integration test requires %s", singBoxPath)
	}
	server := ServerInput{
		ID:       "integration-test",
		Name:     "integration-test",
		Protocol: "VLESS",
		Address:  os.Getenv("CHOOBS_TEST_VLESS_HOST"),
		URI:      os.Getenv("CHOOBS_TEST_VLESS_URI"),
	}
	server.Port, err = strconv.Atoi(os.Getenv("CHOOBS_TEST_VLESS_PORT"))
	if err != nil || server.Address == "" || server.URI == "" {
		t.Skip("integration test requires CHOOBS_TEST_VLESS_HOST, CHOOBS_TEST_VLESS_PORT and CHOOBS_TEST_VLESS_URI")
	}

	dataDirectory := t.TempDir()
	manager := NewCoreManager(ManagerPaths{
		SingBoxExecutable: singBoxPath,
		ConfigFile:        filepath.Join(dataDirectory, "runtime.json"),
		LogFile:           filepath.Join(dataDirectory, "sing-box.log"),
	})
	manager.SetProxyController(&fakeProxyController{})
	status := manager.Start(server)
	stopped := false
	defer func() {
		if !stopped {
			manager.Stop()
		}
	}()
	if status.State != "running" || !status.Running || status.PID == nil || status.ExternalIP == "" {
		t.Fatalf("sing-box did not start: %#v", status)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status = manager.Status()
		if status.State == "error" || status.State == "stopped" {
			t.Fatalf("sing-box exited before stop: %#v", status)
		}
		time.Sleep(25 * time.Millisecond)
	}
	status = manager.Stop()
	if status.State != "stopped" || status.Running || status.PID != nil {
		t.Fatalf("sing-box did not stop: %#v", status)
	}
	stopped = true
}
