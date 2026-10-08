//go:build !windows

package main

import "errors"

func showWindowsError(string) error {
	return errors.New("Windows message dialogs are unavailable")
}
