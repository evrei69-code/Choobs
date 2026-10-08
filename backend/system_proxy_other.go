//go:build !windows

package main

import "errors"

type unsupportedProxyController struct{}

func newPlatformSystemProxyController(string) ProxyController {
	return unsupportedProxyController{}
}

func (unsupportedProxyController) Apply(uint16) error {
	return errors.New("automatic system proxy routing is only available on Windows")
}

func (unsupportedProxyController) Restore() error { return nil }

func (unsupportedProxyController) Recover() error { return nil }
