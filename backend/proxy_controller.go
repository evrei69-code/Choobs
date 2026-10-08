package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	TrafficModeProxy TrafficMode = "proxy"
	TrafficModeTUN   TrafficMode = "tun"
)

type TrafficMode string

type ProxyController interface {
	Apply(uint16) error
	Restore() error
	Recover() error
}

type RegistryValue struct {
	Exists bool   `json:"exists"`
	Type   uint32 `json:"type,omitempty"`
	Data   []byte `json:"data,omitempty"`
}

type proxyValueStore interface {
	Read(string) (RegistryValue, error)
	Write(string, RegistryValue) error
	Delete(string) error
	Notify() error
}

type proxySession struct {
	Version  int                      `json:"version"`
	ID       string                   `json:"id"`
	Original map[string]RegistryValue `json:"original"`
	Applied  map[string]RegistryValue `json:"applied"`
}

type systemProxyController struct {
	mu        sync.Mutex
	statePath string
	store     proxyValueStore
}

var managedProxyValues = []string{
	"ProxyEnable",
	"ProxyServer",
	"ProxyOverride",
	"AutoConfigURL",
}

func newSystemProxyController(statePath string) ProxyController {
	return newPlatformSystemProxyController(statePath)
}

func (controller *systemProxyController) Apply(port uint16) error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if port == 0 {
		return errors.New("local proxy port is invalid")
	}
	if err := controller.restoreLocked(); err != nil {
		return err
	}

	session := proxySession{
		Version:  1,
		Original: make(map[string]RegistryValue, len(managedProxyValues)),
		Applied:  make(map[string]RegistryValue, len(managedProxyValues)),
	}
	sessionID, err := randomSessionID()
	if err != nil {
		return errors.New("could not create a Windows proxy session identifier")
	}
	session.ID = sessionID
	proxyServer := registryString(fmt.Sprintf("http=127.0.0.1:%d;https=127.0.0.1:%d", port, port))
	emptyOverride := registryString("")
	enable := registryDWORD(1)
	for _, name := range managedProxyValues {
		value, err := controller.store.Read(name)
		if err != nil {
			return errors.New("could not read existing Windows proxy settings")
		}
		session.Original[name] = value
	}
	session.Applied["ProxyServer"] = proxyServer
	session.Applied["ProxyOverride"] = emptyOverride
	session.Applied["AutoConfigURL"] = RegistryValue{}
	session.Applied["ProxyEnable"] = enable
	if err := controller.saveSession(session); err != nil {
		return errors.New("could not save the previous Windows proxy settings")
	}

	changes := []string{"ProxyServer", "ProxyOverride", "AutoConfigURL", "ProxyEnable"}
	for _, name := range changes {
		if err := controller.writeValue(name, session.Applied[name]); err != nil {
			restoreErr := controller.restoreLocked()
			if restoreErr != nil {
				return errors.New("could not apply the Windows proxy or safely restore its previous state")
			}
			return errors.New("could not apply the Windows proxy settings")
		}
	}
	if err := controller.store.Notify(); err != nil {
		if controller.restoreLocked() != nil {
			return errors.New("could not notify Windows about proxy changes or restore its previous state")
		}
		return errors.New("could not notify Windows about proxy changes")
	}
	return nil
}

func (controller *systemProxyController) Restore() error {
	controller.mu.Lock()
	defer controller.mu.Unlock()
	return controller.restoreLocked()
}

func (controller *systemProxyController) Recover() error {
	return controller.Restore()
}

func (controller *systemProxyController) restoreLocked() error {
	session, err := controller.readSession()
	if err != nil {
		return errors.New("saved Windows proxy recovery state is invalid")
	}
	if session == nil {
		return nil
	}
	for _, name := range managedProxyValues {
		expected, ok := session.Applied[name]
		if !ok {
			return errors.New("saved Windows proxy recovery state is incomplete")
		}
		current, err := controller.store.Read(name)
		if err != nil {
			return errors.New("could not inspect current Windows proxy settings")
		}
		if !equalRegistryValue(current, expected) {
			continue
		}
		if err := controller.writeValue(name, session.Original[name]); err != nil {
			return errors.New("could not restore previous Windows proxy settings")
		}
	}
	if err := controller.store.Notify(); err != nil {
		return errors.New("could not notify Windows after restoring proxy settings")
	}
	if err := os.Remove(controller.statePath); err != nil && !os.IsNotExist(err) {
		return errors.New("could not clear Windows proxy recovery state")
	}
	return nil
}

func (controller *systemProxyController) writeValue(name string, value RegistryValue) error {
	if value.Exists {
		return controller.store.Write(name, value)
	}
	return controller.store.Delete(name)
}

func (controller *systemProxyController) saveSession(session proxySession) error {
	if err := os.MkdirAll(filepath.Dir(controller.statePath), 0700); err != nil {
		return err
	}
	contents, err := json.Marshal(session)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(controller.statePath), ".proxy-session-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, controller.statePath); err != nil {
		return err
	}
	return nil
}

func (controller *systemProxyController) readSession() (*proxySession, error) {
	contents, err := os.ReadFile(controller.statePath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var session proxySession
	if err := json.Unmarshal(contents, &session); err != nil {
		return nil, err
	}
	if session.Version != 1 || len(session.ID) != 32 || len(session.Original) != len(managedProxyValues) ||
		len(session.Applied) != len(managedProxyValues) {
		return nil, errors.New("invalid Windows proxy session")
	}
	if _, err := hex.DecodeString(session.ID); err != nil {
		return nil, err
	}
	for _, name := range managedProxyValues {
		if _, ok := session.Original[name]; !ok {
			return nil, errors.New("missing original Windows proxy value")
		}
		if _, ok := session.Applied[name]; !ok {
			return nil, errors.New("missing applied Windows proxy value")
		}
	}
	return &session, nil
}

func equalRegistryValue(left, right RegistryValue) bool {
	if left.Exists != right.Exists || left.Type != right.Type || len(left.Data) != len(right.Data) {
		return false
	}
	for index := range left.Data {
		if left.Data[index] != right.Data[index] {
			return false
		}
	}
	return true
}

func randomSessionID() (string, error) {
	var identifier [16]byte
	if _, err := rand.Read(identifier[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(identifier[:]), nil
}

func registryString(value string) RegistryValue {
	data := make([]byte, (len(value)+1)*2)
	for index, character := range value {
		data[index*2] = byte(character)
		data[index*2+1] = byte(character >> 8)
	}
	return RegistryValue{Exists: true, Type: 1, Data: data}
}

func registryDWORD(value uint32) RegistryValue {
	return RegistryValue{
		Exists: true,
		Type:   4,
		Data: []byte{
			byte(value),
			byte(value >> 8),
			byte(value >> 16),
			byte(value >> 24),
		},
	}
}
