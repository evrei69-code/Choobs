//go:build windows

package main

import (
	"errors"
	"syscall"
	"unsafe"
)

const (
	internetOptionSettingsChanged = 39
	internetOptionRefresh         = 37
)

var (
	registrySetValueEx  = syscall.NewLazyDLL("advapi32.dll").NewProc("RegSetValueExW")
	registryDeleteValue = syscall.NewLazyDLL("advapi32.dll").NewProc("RegDeleteValueW")
	internetSetOption   = syscall.NewLazyDLL("wininet.dll").NewProc("InternetSetOptionW")
)

type windowsProxyValueStore struct{}

func newPlatformSystemProxyController(statePath string) ProxyController {
	return &systemProxyController{statePath: statePath, store: windowsProxyValueStore{}}
}

func (windowsProxyValueStore) Read(name string) (RegistryValue, error) {
	key, err := openInternetSettingsKey(syscall.KEY_QUERY_VALUE)
	if err != nil {
		return RegistryValue{}, err
	}
	defer syscall.RegCloseKey(key)
	valueName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return RegistryValue{}, err
	}
	var valueType uint32
	var size uint32
	err = syscall.RegQueryValueEx(key, valueName, nil, &valueType, nil, &size)
	if err == syscall.ERROR_FILE_NOT_FOUND {
		return RegistryValue{}, nil
	}
	if err != syscall.ERROR_MORE_DATA && err != nil {
		return RegistryValue{}, err
	}
	data := make([]byte, size)
	if size > 0 {
		err = syscall.RegQueryValueEx(key, valueName, nil, &valueType, &data[0], &size)
		if err != nil {
			return RegistryValue{}, err
		}
		data = data[:size]
	}
	return RegistryValue{Exists: true, Type: valueType, Data: data}, nil
}

func (windowsProxyValueStore) Write(name string, value RegistryValue) error {
	if !value.Exists || len(value.Data) > 1024*1024 {
		return errors.New("invalid Windows proxy registry value")
	}
	key, err := openInternetSettingsKey(syscall.KEY_SET_VALUE)
	if err != nil {
		return err
	}
	defer syscall.RegCloseKey(key)
	valueName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var data *byte
	if len(value.Data) > 0 {
		data = &value.Data[0]
	}
	result, _, callErr := registrySetValueEx.Call(
		uintptr(key),
		uintptr(unsafe.Pointer(valueName)),
		0,
		uintptr(value.Type),
		uintptr(unsafe.Pointer(data)),
		uintptr(uint32(len(value.Data))),
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	_ = callErr
	return nil
}

func (windowsProxyValueStore) Delete(name string) error {
	key, err := openInternetSettingsKey(syscall.KEY_SET_VALUE)
	if err != nil {
		return err
	}
	defer syscall.RegCloseKey(key)
	valueName, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	result, _, _ := registryDeleteValue.Call(uintptr(key), uintptr(unsafe.Pointer(valueName)))
	if result == uintptr(syscall.ERROR_FILE_NOT_FOUND) {
		return nil
	}
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}

func (windowsProxyValueStore) Notify() error {
	for _, option := range []uintptr{internetOptionSettingsChanged, internetOptionRefresh} {
		result, _, callErr := internetSetOption.Call(0, option, 0, 0)
		if result == 0 {
			if callErr != syscall.Errno(0) {
				return callErr
			}
			return errors.New("InternetSetOptionW failed")
		}
	}
	return nil
}

func openInternetSettingsKey(access uint32) (syscall.Handle, error) {
	subkey, err := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Internet Settings`)
	if err != nil {
		return 0, err
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, subkey, 0, access, &key); err != nil {
		return 0, err
	}
	return key, nil
}
