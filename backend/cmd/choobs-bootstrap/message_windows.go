package main

import (
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func showWindowsError(message string) error {
	text := append(utf16.Encode([]rune(message)), 0)
	title := append(utf16.Encode([]rune("Choobs")), 0)
	result, _, callErr := messageBox.Call(0, uintptr(unsafe.Pointer(&text[0])), uintptr(unsafe.Pointer(&title[0])), 0x10)
	if result == 0 {
		return callErr
	}
	return nil
}
