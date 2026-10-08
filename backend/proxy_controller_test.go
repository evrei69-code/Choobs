package main

import (
	"os"
	"path/filepath"
	"testing"
)

type memoryProxyStore struct {
	values      map[string]RegistryValue
	failWrite   string
	failRead    string
	failNotify  bool
	notifyCount int
}

func (store *memoryProxyStore) Read(name string) (RegistryValue, error) {
	if store.failRead == name {
		return RegistryValue{}, os.ErrPermission
	}
	return store.values[name], nil
}

func (store *memoryProxyStore) Write(name string, value RegistryValue) error {
	if store.failWrite == name {
		return os.ErrPermission
	}
	store.values[name] = value
	return nil
}

func (store *memoryProxyStore) Delete(name string) error {
	if store.failWrite == name {
		return os.ErrPermission
	}
	delete(store.values, name)
	return nil
}

func (store *memoryProxyStore) Notify() error {
	store.notifyCount++
	if store.failNotify {
		return os.ErrPermission
	}
	return nil
}

func newTestProxyController(t *testing.T, initial map[string]RegistryValue) (*systemProxyController, *memoryProxyStore, string) {
	t.Helper()
	statePath := filepath.Join(t.TempDir(), "system-proxy-session.json")
	values := make(map[string]RegistryValue, len(initial))
	for name, value := range initial {
		value.Data = append([]byte(nil), value.Data...)
		values[name] = value
	}
	store := &memoryProxyStore{values: values}
	return &systemProxyController{statePath: statePath, store: store}, store, statePath
}

func TestSystemProxyApplyAndRestoreWithEmptyInitialState(t *testing.T) {
	controller, store, statePath := newTestProxyController(t, nil)
	if err := controller.Apply(43210); err != nil {
		t.Fatal(err)
	}
	if store.values["ProxyEnable"].Type != 4 || len(store.values["ProxyEnable"].Data) != 4 ||
		store.values["ProxyEnable"].Data[0] != 1 {
		t.Fatalf("proxy enable value was not set: %#v", store.values["ProxyEnable"])
	}
	if got := decodeRegistryString(store.values["ProxyServer"]); got != "http=127.0.0.1:43210;https=127.0.0.1:43210" {
		t.Fatalf("unexpected proxy server value: %q", got)
	}
	if got := decodeRegistryString(store.values["ProxyOverride"]); got != "" {
		t.Fatalf("unexpected proxy bypass value: %q", got)
	}
	if _, exists := store.values["AutoConfigURL"]; exists {
		t.Fatal("PAC URL should be disabled while Choobs proxy is active")
	}
	if err := controller.Restore(); err != nil {
		t.Fatal(err)
	}
	if len(store.values) != 0 {
		t.Fatalf("empty original proxy state was not restored: %#v", store.values)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("proxy session state was not cleared: %v", err)
	}
}

func TestSystemProxyRestoresExistingProxyAndPACValues(t *testing.T) {
	initial := map[string]RegistryValue{
		"ProxyEnable":   registryDWORD(1),
		"ProxyServer":   registryString("http=old-proxy.example:8080;https=old-proxy.example:8443"),
		"ProxyOverride": registryString("localhost;*.internal"),
		"AutoConfigURL": registryString("https://pac.example/proxy.pac"),
	}
	controller, store, _ := newTestProxyController(t, initial)
	if err := controller.Apply(43210); err != nil {
		t.Fatal(err)
	}
	if got := decodeRegistryString(store.values["ProxyServer"]); got == decodeRegistryString(initial["ProxyServer"]) {
		t.Fatal("existing proxy should be replaced during the Choobs session")
	}
	if err := controller.Restore(); err != nil {
		t.Fatal(err)
	}
	for name, original := range initial {
		if !equalRegistryValue(store.values[name], original) {
			t.Errorf("%s was not restored: got %#v, want %#v", name, store.values[name], original)
		}
	}
}

func TestSystemProxyRestoresStaleSessionAndIsIdempotent(t *testing.T) {
	controller, store, statePath := newTestProxyController(t, map[string]RegistryValue{
		"ProxyEnable": registryDWORD(0),
	})
	if err := controller.Apply(43210); err != nil {
		t.Fatal(err)
	}
	restarted := &systemProxyController{statePath: statePath, store: store}
	if err := restarted.Recover(); err != nil {
		t.Fatal(err)
	}
	if !equalRegistryValue(store.values["ProxyEnable"], registryDWORD(0)) {
		t.Fatalf("stale session recovery did not restore original ProxyEnable: %#v", store.values["ProxyEnable"])
	}
	if err := restarted.Restore(); err != nil {
		t.Fatalf("repeated restore should be safe: %v", err)
	}
}

func TestSystemProxyDoesNotOverwriteUserChangesMadeDuringSession(t *testing.T) {
	controller, store, _ := newTestProxyController(t, map[string]RegistryValue{
		"ProxyEnable": registryDWORD(0),
	})
	if err := controller.Apply(43210); err != nil {
		t.Fatal(err)
	}
	userChoice := registryString("http=manual-proxy.example:9000")
	store.values["ProxyServer"] = userChoice
	if err := controller.Restore(); err != nil {
		t.Fatal(err)
	}
	if !equalRegistryValue(store.values["ProxyServer"], userChoice) {
		t.Fatal("a proxy setting changed by the user was overwritten during restore")
	}
	if !equalRegistryValue(store.values["ProxyEnable"], registryDWORD(0)) {
		t.Fatal("the untouched Choobs setting was not restored")
	}
}

func TestSystemProxyApplyFailureRollsBackChangedValues(t *testing.T) {
	initial := map[string]RegistryValue{
		"ProxyEnable": registryDWORD(0),
		"ProxyServer": registryString("old-proxy.example:8080"),
	}
	controller, store, statePath := newTestProxyController(t, initial)
	store.failWrite = "ProxyEnable"
	if err := controller.Apply(43210); err == nil {
		t.Fatal("expected simulated registry write failure")
	}
	if !equalRegistryValue(store.values["ProxyEnable"], initial["ProxyEnable"]) ||
		!equalRegistryValue(store.values["ProxyServer"], initial["ProxyServer"]) {
		t.Fatalf("failed apply did not restore original proxy state: %#v", store.values)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("failed apply left a recovery file after successful rollback: %v", err)
	}
}

func TestSystemProxyDoesNotApplyWhenOriginalSettingsCannotBeRead(t *testing.T) {
	controller, store, statePath := newTestProxyController(t, nil)
	store.failRead = "ProxyServer"
	if err := controller.Apply(43210); err == nil {
		t.Fatal("expected simulated registry read failure")
	}
	if len(store.values) != 0 {
		t.Fatalf("proxy settings changed despite failing to read original state: %#v", store.values)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("state file exists despite a read failure: %v", err)
	}
}

func TestSystemProxyNotifyFailureLeavesRecoverableState(t *testing.T) {
	controller, store, statePath := newTestProxyController(t, map[string]RegistryValue{
		"ProxyEnable": registryDWORD(0),
	})
	store.failNotify = true
	if err := controller.Apply(43210); err == nil {
		t.Fatal("expected simulated WinINet notification failure")
	}
	if !equalRegistryValue(store.values["ProxyEnable"], registryDWORD(0)) {
		t.Fatal("notification failure did not roll back the enabled proxy")
	}
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("failed recovery state should remain for the next startup: %v", err)
	}
	store.failNotify = false
	if err := controller.Recover(); err != nil {
		t.Fatalf("recovery after notification failure failed: %v", err)
	}
	if store.notifyCount < 3 {
		t.Fatalf("recovery did not retry the WinINet notification: %d notifications", store.notifyCount)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("recovery state was not removed: %v", err)
	}
}

func TestSystemProxyRestoreFailureRetainsStateForRetry(t *testing.T) {
	controller, store, statePath := newTestProxyController(t, map[string]RegistryValue{
		"ProxyEnable": registryDWORD(0),
	})
	if err := controller.Apply(43210); err != nil {
		t.Fatal(err)
	}
	store.failWrite = "ProxyServer"
	if err := controller.Restore(); err == nil {
		t.Fatal("expected simulated registry restoration failure")
	}
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("failed restore did not retain recovery state: %v", err)
	}
	store.failWrite = ""
	if err := controller.Recover(); err != nil {
		t.Fatalf("recovery retry failed: %v", err)
	}
	if len(store.values) != 1 || !equalRegistryValue(store.values["ProxyEnable"], registryDWORD(0)) {
		t.Fatalf("recovery retry did not restore original settings: %#v", store.values)
	}
}

func decodeRegistryString(value RegistryValue) string {
	if !value.Exists || len(value.Data) < 2 {
		return ""
	}
	runes := make([]rune, 0, len(value.Data)/2)
	for index := 0; index+1 < len(value.Data); index += 2 {
		character := rune(value.Data[index]) | rune(value.Data[index+1])<<8
		if character == 0 {
			break
		}
		runes = append(runes, character)
	}
	return string(runes)
}
