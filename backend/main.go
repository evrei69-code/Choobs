package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type managerRequest struct {
	ID      string       `json:"id"`
	Command string       `json:"command"`
	Server  *ServerInput `json:"server,omitempty"`
}

type managerResponse struct {
	ID     string     `json:"id"`
	Status CoreStatus `json:"status"`
}

func applicationRoot(executablePath string) string {
	return filepath.Dir(filepath.Dir(executablePath))
}

func newApplicationManager(executablePath string) (*CoreManager, error) {
	root := applicationRoot(executablePath)
	dataDirectory := root
	if configuredDataDirectory := os.Getenv("CHOOBS_DATA_DIRECTORY"); configuredDataDirectory != "" {
		if !filepath.IsAbs(configuredDataDirectory) {
			return nil, fmt.Errorf("core data directory must be an absolute path")
		}
		dataDirectory = configuredDataDirectory
	}
	coreDirectory := filepath.Join(root, "core")
	dataCoreDirectory := filepath.Join(dataDirectory, "core")
	executableName := "sing-box"
	if runtime.GOOS == "windows" {
		executableName += ".exe"
	}
	paths := ManagerPaths{
		SingBoxExecutable: filepath.Join(coreDirectory, "bin", executableName),
		ConfigFile:        filepath.Join(dataCoreDirectory, "configs", "runtime.json"),
		LogFile:           filepath.Join(dataCoreDirectory, "logs", "sing-box.log"),
		ProxyStateFile:    filepath.Join(dataDirectory, "system-proxy-session.json"),
	}
	if err := os.Remove(paths.ConfigFile); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("could not clear stale runtime config")
	}
	manager := NewCoreManager(paths)
	manager.SetProxyController(newSystemProxyController(paths.ProxyStateFile))
	if err := manager.RecoverProxySettings(); err != nil {
		return nil, fmt.Errorf("could not recover previous Windows proxy settings")
	}
	return manager, nil
}

func serve(input io.Reader, output io.Writer, manager *CoreManager) error {
	defer manager.Stop()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	encoder := json.NewEncoder(output)

	for scanner.Scan() {
		var request managerRequest
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			if err := encoder.Encode(managerResponse{Status: ErrorStatus(err)}); err != nil {
				return err
			}
			continue
		}

		var status CoreStatus
		switch request.Command {
		case "start":
			if request.Server == nil {
				status = ErrorStatus(fmt.Errorf("start requires a server"))
			} else {
				status = manager.Start(*request.Server)
			}
		case "stop":
			status = manager.Stop()
		case "restart":
			status = manager.Restart(request.Server)
		case "status":
			status = manager.Status()
		default:
			status = ErrorStatus(fmt.Errorf("unsupported core command"))
		}

		if err := encoder.Encode(managerResponse{ID: request.ID, Status: status}); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	status := manager.Stop()
	if status.State == "error" && status.Running {
		return status.AsError()
	}
	return nil
}

func main() {
	executablePath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "could not locate Core Manager executable")
		os.Exit(1)
	}

	manager, err := newApplicationManager(executablePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Core Manager configuration is invalid")
		os.Exit(1)
	}
	if err := serve(os.Stdin, os.Stdout, manager); err != nil {
		fmt.Fprintln(os.Stderr, "Core Manager service failed")
		os.Exit(1)
	}
}
