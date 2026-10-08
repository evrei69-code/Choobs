package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maximumLogBytes int64 = 2 * 1024 * 1024

type ManagerPaths struct {
	SingBoxExecutable string
	ConfigFile        string
	LogFile           string
	ProxyStateFile    string
}

type CoreStatus struct {
	Running      bool   `json:"running"`
	PID          *int   `json:"pid"`
	State        string `json:"state"`
	ErrorCode    string `json:"code,omitempty"`
	Error        string `json:"error,omitempty"`
	ProxyAddress string `json:"proxyAddress,omitempty"`
	ProxyPort    uint16 `json:"proxyPort,omitempty"`
	ExternalIP   string `json:"externalIP,omitempty"`
	TrafficMode  string `json:"trafficMode,omitempty"`
}

func ErrorStatus(err error) CoreStatus {
	if err == nil {
		err = errors.New("core manager failed")
	}
	return CoreStatus{State: "error", ErrorCode: "CORE_ERROR", Error: err.Error()}
}

func (status CoreStatus) AsError() error {
	if status.State == "error" {
		return errors.New(status.Error)
	}
	return nil
}

type CoreManager struct {
	mu              sync.Mutex
	paths           ManagerPaths
	state           string
	lastError       string
	errorCode       string
	command         *exec.Cmd
	done            chan struct{}
	logFile         *os.File
	logger          *boundedLogWriter
	logWriters      []*prefixedLogWriter
	lastServer      *ServerInput
	proxyPort       uint16
	externalIP      string
	commandArgs     []string
	commandEnv      []string
	validateConfig  func(string, []string, *boundedLogWriter) error
	proxyReady      func(uint16) bool
	checkProxy      func(uint16) (string, error)
	proxyController ProxyController
}

func NewCoreManager(paths ManagerPaths) *CoreManager {
	return &CoreManager{paths: paths, state: "stopped"}
}

func (manager *CoreManager) SetProxyController(controller ProxyController) {
	manager.mu.Lock()
	manager.proxyController = controller
	manager.mu.Unlock()
}

func (manager *CoreManager) RecoverProxySettings() error {
	manager.mu.Lock()
	controller := manager.proxyController
	manager.mu.Unlock()
	if controller == nil {
		return errors.New("system proxy controller is not configured")
	}
	return controller.Recover()
}

func (manager *CoreManager) Start(server ServerInput) CoreStatus {
	manager.mu.Lock()
	if manager.command != nil {
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	if manager.state == "error" {
		manager.state = "stopped"
		manager.lastError = ""
		manager.errorCode = ""
	}
	manager.state = "starting"
	manager.lastError = ""
	manager.errorCode = ""
	manager.proxyPort = 0
	manager.externalIP = ""

	info, err := os.Stat(manager.paths.SingBoxExecutable)
	if err != nil || !info.Mode().IsRegular() {
		status := manager.setErrorLocked("CORE_NOT_FOUND", errors.New("VPN core not found. Install sing-box in core/bin."))
		manager.mu.Unlock()
		return status
	}
	proxyPort, err := chooseProxyPort()
	if err != nil {
		status := manager.setErrorLocked("PROXY_NOT_READY", errors.New("Could not reserve a local proxy port."))
		manager.mu.Unlock()
		return status
	}
	config, secrets, err := GenerateRuntimeConfig(server, proxyPort)
	if err != nil {
		code := "CONFIG_INVALID"
		if server.Protocol != "VLESS" || strings.Contains(err.Error(), "not supported") ||
			strings.Contains(err.Error(), "not implemented") {
			code = "UNSUPPORTED_PROTOCOL"
		}
		status := manager.setErrorLocked(code, err)
		manager.mu.Unlock()
		return status
	}
	if err := writeRuntimeConfig(manager.paths.ConfigFile, config); err != nil {
		status := manager.setErrorLocked("CONFIG_INVALID", errors.New("Could not create the runtime VPN configuration."))
		manager.mu.Unlock()
		return status
	}

	logFile, remainingLogBytes, err := openCoreLog(manager.paths.LogFile)
	if err != nil {
		_ = os.Remove(manager.paths.ConfigFile)
		status := manager.setErrorLocked("CORE_START_FAILED", errors.New("Could not open the VPN core log."))
		manager.mu.Unlock()
		return status
	}
	logger := &boundedLogWriter{file: logFile, remaining: remainingLogBytes, secrets: secrets}
	manager.logger = logger
	_, _ = io.WriteString(logger, "[CORE] Starting sing-box\n")

	args := manager.commandArgs
	if args == nil {
		if err := validateSingBoxConfig(manager.paths.SingBoxExecutable, manager.paths.ConfigFile, logger); err != nil {
			_ = logger.Flush()
			_ = logFile.Close()
			_ = os.Remove(manager.paths.ConfigFile)
			status := manager.setErrorLocked("CONFIG_INVALID", errors.New("Invalid sing-box configuration."))
			manager.mu.Unlock()
			return status
		}
		args = []string{"run", "-c", manager.paths.ConfigFile}
	} else if manager.validateConfig != nil {
		if err := manager.validateConfig(manager.paths.ConfigFile, secrets, logger); err != nil {
			_ = logger.Flush()
			_ = logFile.Close()
			_ = os.Remove(manager.paths.ConfigFile)
			status := manager.setErrorLocked("CONFIG_INVALID", errors.New("Invalid sing-box configuration."))
			manager.mu.Unlock()
			return status
		}
	}

	command := exec.Command(manager.paths.SingBoxExecutable, args...)
	if manager.commandEnv != nil {
		command.Env = manager.commandEnv
	}
	stdoutLog := &prefixedLogWriter{writer: logger, prefix: "[stdout] "}
	stderrLog := &prefixedLogWriter{writer: logger, prefix: "[stderr] "}
	command.Stdout = stdoutLog
	command.Stderr = stderrLog
	if err := command.Start(); err != nil {
		_ = logger.Flush()
		_ = logFile.Close()
		_ = os.Remove(manager.paths.ConfigFile)
		status := manager.setErrorLocked("CORE_START_FAILED", errors.New("Could not start the VPN core."))
		manager.mu.Unlock()
		return status
	}

	manager.command = command
	manager.done = make(chan struct{})
	manager.logFile = logFile
	manager.logWriters = []*prefixedLogWriter{stdoutLog, stderrLog}
	manager.lastServer = &server
	manager.proxyPort = proxyPort
	manager.state = "starting"
	done := manager.done
	go manager.wait(command, done, logFile)
	manager.mu.Unlock()

	if logger != nil {
		_, _ = io.WriteString(logger, "[CORE] sing-box started\n")
	}
	if err := waitForProxy(proxyPort, done, manager.proxyReady); err != nil {
		return manager.failAndStop(command, "PROXY_NOT_READY", errors.New("Local proxy did not start."))
	}
	if logger != nil {
		_, _ = io.WriteString(logger, "[PROXY] Local proxy listening\n")
	}
	externalIP, err := checkExternalIP(proxyPort, manager.checkProxy)
	if err != nil {
		return manager.failAndStop(command, "CONNECTIVITY_FAILED", errors.New("Could not verify an Internet connection through the VPN proxy."))
	}
	if logger != nil {
		_, _ = io.WriteString(logger, "[PROXY] Proxy health check passed\n")
	}

	manager.mu.Lock()
	if manager.command != command || manager.state != "starting" {
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	controller := manager.proxyController
	logger = manager.logger
	if controller == nil {
		manager.mu.Unlock()
		return manager.failAndStop(command, "PROXY_APPLY_FAILED", errors.New("Automatic Windows proxy routing is unavailable."))
	}
	if logger != nil {
		_, _ = io.WriteString(logger, "[SYSTEM] Saving Windows proxy state\n")
	}
	if err := controller.Apply(proxyPort); err != nil {
		manager.mu.Unlock()
		return manager.failAndStop(command, "PROXY_APPLY_FAILED", errors.New("Could not apply Windows proxy settings; previous settings were preserved."))
	}

	if logger != nil {
		_, _ = io.WriteString(logger, "[SYSTEM] Applying Choobs proxy\n[VPN] Outbound health check passed\n[VPN] Connected\n")
	}
	manager.externalIP = externalIP
	manager.state = "running"
	_, _ = io.WriteString(manager.logger, "[lifecycle] proxy and external connectivity verified\n")
	status := manager.statusLocked()
	manager.mu.Unlock()
	return status
}

func (manager *CoreManager) Stop() CoreStatus {
	manager.mu.Lock()
	if manager.command == nil {
		controller := manager.proxyController
		manager.mu.Unlock()
		if controller != nil {
			if err := controller.Restore(); err != nil {
				manager.mu.Lock()
				manager.state = "error"
				manager.errorCode = "PROXY_RESTORE_FAILED"
				manager.lastError = "Could not restore previous Windows proxy settings."
				status := manager.statusLocked()
				manager.mu.Unlock()
				return status
			}
		}
		manager.mu.Lock()
		manager.state = "stopped"
		manager.lastError = ""
		manager.errorCode = ""
		manager.proxyPort = 0
		manager.externalIP = ""
		if err := os.Remove(manager.paths.ConfigFile); err != nil && !os.IsNotExist(err) {
			manager.state = "error"
			manager.errorCode = "STOP_FAILED"
			manager.lastError = "Could not remove the temporary VPN configuration."
		}
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	controller := manager.proxyController
	command := manager.command
	done := manager.done
	if manager.logger != nil {
		_, _ = io.WriteString(manager.logger, "[VPN] Disconnecting\n[SYSTEM] Restoring previous proxy state\n")
	}
	manager.state = "stopping"
	manager.mu.Unlock()
	if controller != nil {
		if err := controller.Restore(); err != nil {
			manager.mu.Lock()
			if manager.command == command {
				select {
				case <-done:
					manager.state = "error"
				default:
					manager.state = "running"
				}
				manager.errorCode = "PROXY_RESTORE_FAILED"
				manager.lastError = "Could not restore previous Windows proxy settings; VPN core remains running."
			}
			status := manager.statusLocked()
			manager.mu.Unlock()
			return status
		}
	}
	manager.mu.Lock()
	if manager.command != command {
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	if manager.logger != nil {
		_, _ = io.WriteString(manager.logger, "[CORE] Stopping sing-box\n")
	}
	if err := command.Process.Kill(); err != nil {
		manager.mu.Unlock()
		select {
		case <-done:
			return manager.Status()
		default:
		}
		manager.mu.Lock()
		if manager.command != command {
			status := manager.statusLocked()
			manager.mu.Unlock()
			return status
		}
		manager.state = "error"
		manager.errorCode = "STOP_FAILED"
		manager.lastError = "Could not stop the VPN core."
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	manager.mu.Unlock()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		return manager.stopError("Timed out waiting for the VPN core to stop.")
	}
	if err := os.Remove(manager.paths.ConfigFile); err != nil && !os.IsNotExist(err) {
		return manager.stopError("Could not remove the temporary VPN configuration.")
	}
	if err := waitForProxyShutdown(manager.proxyPort); err != nil {
		return manager.stopError("Local VPN proxy is still listening after core shutdown.")
	}
	manager.mu.Lock()
	manager.proxyPort = 0
	manager.externalIP = ""
	manager.lastError = ""
	manager.errorCode = ""
	status := manager.statusLocked()
	if manager.logger != nil {
		_, _ = io.WriteString(manager.logger, "[VPN] Disconnected\n")
	}
	manager.mu.Unlock()
	return status
}

func (manager *CoreManager) stopError(message string) CoreStatus {
	manager.mu.Lock()
	manager.state = "error"
	manager.errorCode = "STOP_FAILED"
	manager.lastError = message
	status := manager.statusLocked()
	manager.mu.Unlock()
	return status
}

func (manager *CoreManager) Restart(server *ServerInput) CoreStatus {
	manager.mu.Lock()
	var selected *ServerInput
	if server != nil {
		copy := *server
		selected = &copy
	} else if manager.lastServer != nil {
		copy := *manager.lastServer
		selected = &copy
	}
	manager.mu.Unlock()
	if selected == nil {
		return ErrorStatus(errors.New("Reconnect requires a selected server."))
	}
	if status := manager.Stop(); status.State == "error" {
		return status
	}
	return manager.Start(*selected)
}

func (manager *CoreManager) Status() CoreStatus {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.statusLocked()
}

func (manager *CoreManager) statusLocked() CoreStatus {
	status := CoreStatus{
		Running:      manager.command != nil && manager.command.Process != nil,
		State:        manager.state,
		ProxyAddress: "127.0.0.1",
		ProxyPort:    manager.proxyPort,
		ExternalIP:   manager.externalIP,
	}
	if status.Running && manager.state == "running" {
		status.TrafficMode = string(TrafficModeProxy)
	}
	if manager.state == "stopped" || (manager.state == "error" && manager.command == nil) {
		status.ProxyAddress = ""
		status.ProxyPort = 0
		status.ExternalIP = ""
	}
	if status.Running {
		pid := manager.command.Process.Pid
		status.PID = &pid
	}
	if manager.state == "error" || manager.lastError != "" {
		status.Error = manager.lastError
		status.ErrorCode = manager.errorCode
	}
	return status
}

func (manager *CoreManager) setErrorLocked(code string, err error) CoreStatus {
	manager.state = "error"
	manager.lastError = err.Error()
	manager.errorCode = code
	manager.command = nil
	manager.done = nil
	manager.logger = nil
	return manager.statusLocked()
}

func (manager *CoreManager) failAndStop(command *exec.Cmd, code string, failure error) CoreStatus {
	manager.mu.Lock()
	if manager.command != command {
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	manager.state = "stopping"
	controller := manager.proxyController
	if manager.logger != nil {
		_, _ = io.WriteString(manager.logger, "[VPN] Disconnecting after connection check failure\n[SYSTEM] Restoring previous proxy state\n")
	}
	done := manager.done
	manager.mu.Unlock()

	if controller != nil {
		if err := controller.Restore(); err != nil {
			manager.mu.Lock()
			if manager.command == command {
				manager.state = "error"
				manager.errorCode = "PROXY_RESTORE_FAILED"
				manager.lastError = "Could not restore previous Windows proxy settings; VPN core remains running."
			}
			status := manager.statusLocked()
			manager.mu.Unlock()
			return status
		}
	}
	manager.mu.Lock()
	if manager.command != command {
		status := manager.statusLocked()
		manager.mu.Unlock()
		return status
	}
	if manager.logger != nil {
		_, _ = io.WriteString(manager.logger, "[CORE] Stopping sing-box\n")
	}
	manager.mu.Unlock()
	_ = command.Process.Kill()
	stopped := false
	select {
	case <-done:
		stopped = true
	case <-time.After(5 * time.Second):
		failure = errors.New("VPN core did not stop after connection check failed.")
		code = "STOP_FAILED"
	}
	if stopped {
		_ = os.Remove(manager.paths.ConfigFile)
		if err := waitForProxyShutdown(manager.proxyPort); err != nil {
			failure = errors.New("Local VPN proxy remained available after a failed connection check.")
			code = "STOP_FAILED"
		}
	}

	manager.mu.Lock()
	manager.state = "error"
	manager.lastError = failure.Error()
	manager.errorCode = code
	if stopped {
		manager.proxyPort = 0
		manager.externalIP = ""
	}
	status := manager.statusLocked()
	manager.mu.Unlock()
	return status
}

func (manager *CoreManager) wait(command *exec.Cmd, done chan struct{}, logFile *os.File) {
	err := command.Wait()
	manager.mu.Lock()
	logger := manager.logger
	logWriters := append([]*prefixedLogWriter(nil), manager.logWriters...)
	controller := manager.proxyController
	manager.mu.Unlock()
	restoreErr := error(nil)
	if controller != nil {
		restoreErr = controller.Restore()
	}
	if logger != nil {
		_, _ = io.WriteString(logger, "[SYSTEM] Restoring previous proxy state\n")
		if restoreErr == nil {
			_, _ = io.WriteString(logger, "[VPN] Disconnected\n")
		}
	}
	for _, writer := range logWriters {
		_ = writer.Flush()
	}
	if logger != nil {
		_ = logger.Flush()
	}
	_ = logFile.Close()
	_ = os.Remove(manager.paths.ConfigFile)

	manager.mu.Lock()
	if manager.command == command {
		switch {
		case restoreErr != nil:
			manager.state = "error"
			manager.errorCode = "PROXY_RESTORE_FAILED"
			manager.lastError = "VPN core exited and previous Windows proxy settings could not be restored."
		case manager.state == "stopping":
			manager.state = "stopped"
			manager.lastError = ""
			manager.errorCode = ""
		case manager.state == "starting" || manager.state == "running":
			manager.state = "error"
			manager.errorCode = "CORE_EXITED"
			manager.lastError = "VPN core exited unexpectedly."
		default:
			if err != nil {
				manager.state = "error"
				manager.errorCode = "CORE_EXITED"
				manager.lastError = "VPN core exited unexpectedly."
			}
		}
		manager.command = nil
		manager.done = nil
		manager.logFile = nil
		manager.logger = nil
		manager.logWriters = nil
	}
	manager.mu.Unlock()
	close(done)
}

func chooseProxyPort() (uint16, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	if port < 1 || port > 65535 {
		return 0, errors.New("selected proxy port is out of range")
	}
	return uint16(port), nil
}

func validateSingBoxConfig(executablePath, configPath string, output *boundedLogWriter) error {
	command := exec.Command(executablePath, "check", "-c", configPath)
	stdoutLog := &prefixedLogWriter{writer: output, prefix: "[check stdout] "}
	stderrLog := &prefixedLogWriter{writer: output, prefix: "[check stderr] "}
	command.Stdout = stdoutLog
	command.Stderr = stderrLog
	err := command.Run()
	_ = stdoutLog.Flush()
	_ = stderrLog.Flush()
	if err != nil {
		return errors.New("sing-box config validation failed")
	}
	return nil
}

func waitForProxy(port uint16, done <-chan struct{}, probe func(uint16) bool) error {
	deadline := time.Now().Add(5 * time.Second)
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port)))
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return errors.New("VPN core exited before the local proxy became ready")
		default:
		}
		if probe != nil {
			if probe(port) {
				return nil
			}
		} else {
			connection, err := net.DialTimeout("tcp", address, 150*time.Millisecond)
			if err == nil {
				_ = connection.Close()
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("local proxy did not become ready")
}

func waitForProxyShutdown(port uint16) error {
	if port == 0 {
		return nil
	}
	address := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(port)))
	connection, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
	if err != nil {
		return nil
	}
	_ = connection.Close()
	return errors.New("proxy still accepts local connections")
}

func checkExternalIP(port uint16, customCheck func(uint16) (string, error)) (string, error) {
	if customCheck != nil {
		return customCheck(port)
	}
	proxyURL, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	if err != nil {
		return "", errors.New("local proxy address is invalid")
	}
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	endpoints := []string{
		"https://api.ipify.org",
		"https://checkip.amazonaws.com",
		"https://icanhazip.com",
	}
	var lastError error
	for _, endpoint := range endpoints {
		response, requestErr := client.Get(endpoint)
		if requestErr != nil {
			lastError = requestErr
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 256))
		_ = response.Body.Close()
		if readErr != nil {
			lastError = readErr
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			lastError = fmt.Errorf("IP check endpoint returned HTTP %d", response.StatusCode)
			continue
		}
		externalIP := net.ParseIP(strings.TrimSpace(string(body)))
		if externalIP == nil {
			lastError = errors.New("IP check endpoint returned an invalid response")
			continue
		}
		return externalIP.String(), nil
	}
	if lastError == nil {
		lastError = errors.New("no IP check endpoint responded")
	}
	return "", lastError
}

func writeRuntimeConfig(filePath string, contents []byte) error {
	if !json.Valid(contents) {
		return errors.New("generated runtime config is invalid JSON")
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(filePath, contents, 0600); err != nil {
		return err
	}
	return os.Chmod(filePath, 0600)
}

func openCoreLog(filePath string) (*os.File, int64, error) {
	if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
		return nil, 0, err
	}
	info, err := os.Stat(filePath)
	if err == nil && info.Size() >= maximumLogBytes {
		if err := os.Truncate(filePath, 0); err != nil {
			return nil, 0, err
		}
	} else if err != nil && !os.IsNotExist(err) {
		return nil, 0, err
	}
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, 0, err
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return nil, 0, err
	}
	info, err = file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, 0, err
	}
	return file, maximumLogBytes - info.Size(), nil
}

type boundedLogWriter struct {
	mu        sync.Mutex
	file      *os.File
	remaining int64
	secrets   []string
	pending   []byte
}

func (writer *boundedLogWriter) Write(contents []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.remaining <= 0 {
		return len(contents), nil
	}
	writer.pending = append(writer.pending, contents...)
	if int64(len(writer.pending)) > maximumLogBytes {
		writer.pending = nil
		writer.remaining = 0
		return len(contents), nil
	}
	for {
		newline := bytes.IndexByte(writer.pending, '\n')
		if newline < 0 {
			break
		}
		if err := writer.flushPrefixLocked(newline + 1); err != nil {
			return 0, err
		}
	}
	return len(contents), nil
}

func (writer *boundedLogWriter) flushPrefixLocked(length int) error {
	if length <= 0 || writer.remaining <= 0 {
		return nil
	}
	safe := string(writer.pending[:length])
	writer.pending = append(writer.pending[:0], writer.pending[length:]...)
	for _, secret := range writer.secrets {
		if secret != "" {
			safe = strings.ReplaceAll(safe, secret, "[REDACTED]")
		}
	}
	data := []byte(safe)
	if int64(len(data)) > writer.remaining {
		data = data[:writer.remaining]
	}
	written, err := writer.file.Write(data)
	writer.remaining -= int64(written)
	if writer.remaining <= 0 {
		writer.pending = nil
	}
	return err
}

func (writer *boundedLogWriter) Flush() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.pending) == 0 || writer.remaining <= 0 {
		writer.pending = nil
		return nil
	}
	return writer.flushPrefixLocked(len(writer.pending))
}

type prefixedLogWriter struct {
	mu         sync.Mutex
	writer     *boundedLogWriter
	prefix     string
	pending    []byte
	discarding bool
}

func (writer *prefixedLogWriter) Write(contents []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	remaining := contents
	for len(remaining) > 0 {
		if writer.discarding {
			newline := bytes.IndexByte(remaining, '\n')
			if newline < 0 {
				return len(contents), nil
			}
			writer.discarding = false
			remaining = remaining[newline+1:]
			continue
		}
		newline := bytes.IndexByte(remaining, '\n')
		if newline < 0 {
			writer.pending = append(writer.pending, remaining...)
			if int64(len(writer.pending)) > maximumLogBytes {
				writer.pending = nil
				writer.discarding = true
			}
			break
		}
		writer.pending = append(writer.pending, remaining[:newline+1]...)
		if int64(len(writer.pending)) > maximumLogBytes {
			writer.pending = nil
		} else if _, err := writer.writer.Write(append([]byte(writer.prefix), writer.pending...)); err != nil {
			writer.pending = nil
			return 0, err
		}
		writer.pending = nil
		remaining = remaining[newline+1:]
	}
	return len(contents), nil
}

func (writer *prefixedLogWriter) Flush() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if len(writer.pending) == 0 {
		return nil
	}
	pending := append([]byte(writer.prefix), writer.pending...)
	writer.pending = nil
	_, err := writer.writer.Write(pending)
	return err
}
