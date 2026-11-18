package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

//go:embed core-hashes.json
var coreHashesJSON []byte

var errXrayIntegrity = errors.New("Xray core failed its integrity check")

type coreHashManifest struct {
	Xray struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	} `json:"xray"`
}

func expectedXraySHA256() (string, error) {
	var manifest coreHashManifest
	if err := json.Unmarshal(coreHashesJSON, &manifest); err != nil {
		return "", errXrayIntegrity
	}
	if manifest.Xray.Version != "24.11.30" || !validSHA256(manifest.Xray.SHA256) {
		return "", errXrayIntegrity
	}
	return manifest.Xray.SHA256, nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func fileSHA256(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func verifyXrayBinary(filePath string) error {
	expected, err := expectedXraySHA256()
	if err != nil {
		return errXrayIntegrity
	}
	actual, err := fileSHA256(filePath)
	if err != nil || !strings.EqualFold(actual, expected) {
		return errXrayIntegrity
	}
	return nil
}

func stageVerifiedXrayBinary(sourcePath, stagingRoot string, verify func(string) error) (string, string, error) {
	if verify == nil {
		verify = verifyXrayBinary
	}
	if err := os.MkdirAll(stagingRoot, 0700); err != nil {
		return "", "", errXrayIntegrity
	}
	info, err := os.Lstat(stagingRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", "", errXrayIntegrity
	}
	if err := os.Chmod(stagingRoot, 0700); err != nil {
		return "", "", errXrayIntegrity
	}

	stagingDirectory, err := os.MkdirTemp(stagingRoot, "xray-")
	if err != nil {
		return "", "", errXrayIntegrity
	}
	cleanup := func() {
		_ = os.RemoveAll(stagingDirectory)
	}
	stagedPath := filepath.Join(stagingDirectory, "xray.exe")
	source, err := os.Open(sourcePath)
	if err != nil {
		cleanup()
		return "", "", errXrayIntegrity
	}
	staged, err := os.OpenFile(stagedPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		_ = source.Close()
		cleanup()
		return "", "", errXrayIntegrity
	}
	_, copyErr := io.Copy(staged, source)
	sourceCloseErr := source.Close()
	syncErr := staged.Sync()
	closeErr := staged.Close()
	if copyErr != nil || sourceCloseErr != nil || syncErr != nil || closeErr != nil {
		cleanup()
		return "", "", errXrayIntegrity
	}
	if err := os.Chmod(stagedPath, 0500); err != nil {
		cleanup()
		return "", "", errXrayIntegrity
	}
	if err := verify(stagedPath); err != nil {
		cleanup()
		return "", "", errXrayIntegrity
	}
	return stagedPath, stagingDirectory, nil
}
