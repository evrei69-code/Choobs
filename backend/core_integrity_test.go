package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExpectedXraySHA256PinsVerifiedReleaseBinary(t *testing.T) {
	got, err := expectedXraySHA256()
	if err != nil {
		t.Fatal(err)
	}
	const want = "15dc41c5f4f634848deb4e54cf242451cb4de0e0a2fed4c0d0657ecaa2333c53"
	if got != want {
		t.Fatalf("unexpected pinned Xray checksum: %q", got)
	}
}

func TestVerifyXrayBinaryRejectsDifferentFileWithoutLeakingPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "xray.exe")
	if err := os.WriteFile(path, []byte("not the pinned Xray binary"), 0600); err != nil {
		t.Fatal(err)
	}

	err := verifyXrayBinary(path)
	if err == nil || err.Error() != errXrayIntegrity.Error() {
		t.Fatalf("expected a safe Xray integrity error, got %v", err)
	}
	if strings.Contains(err.Error(), path) {
		t.Fatalf("integrity error exposed the executable path: %v", err)
	}
}

func TestFileSHA256MatchesExpectedAndDetectsDamage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.exe")
	data := []byte("known test core")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	expected := hex.EncodeToString(sum[:])

	actual, err := fileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(actual, expected) {
		t.Fatalf("unexpected file SHA-256: %q", actual)
	}

	if err := os.WriteFile(path, []byte("modified test core"), 0600); err != nil {
		t.Fatal(err)
	}
	actual, err = fileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.EqualFold(actual, expected) {
		t.Fatal("modified file unexpectedly matched its original checksum")
	}
}

func TestStageVerifiedXrayBinaryCopiesAndVerifiesStagedFile(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "source.exe")
	source := []byte("verified test executable")
	if err := os.WriteFile(sourcePath, source, 0600); err != nil {
		t.Fatal(err)
	}

	var verifiedPath string
	stagedPath, stagingDirectory, err := stageVerifiedXrayBinary(
		sourcePath,
		filepath.Join(root, "private-runtime"),
		func(path string) error {
			verifiedPath = path
			staged, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if !bytes.Equal(staged, source) {
				t.Fatal("staged executable contents differ from the copied source")
			}
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if stagedPath != verifiedPath || stagedPath == sourcePath {
		t.Fatalf("unexpected staged path %q (verified %q)", stagedPath, verifiedPath)
	}
	if filepath.Dir(stagedPath) != stagingDirectory {
		t.Fatalf("staging directory does not own the executable: %q", stagedPath)
	}
	if err := os.RemoveAll(stagingDirectory); err != nil {
		t.Fatal(err)
	}
}

func TestStageVerifiedXrayBinaryRejectsStagedHashFailure(t *testing.T) {
	root := t.TempDir()
	sourcePath := filepath.Join(root, "source.exe")
	if err := os.WriteFile(sourcePath, []byte("test executable"), 0600); err != nil {
		t.Fatal(err)
	}

	stagedPath, stagingDirectory, err := stageVerifiedXrayBinary(
		sourcePath,
		filepath.Join(root, "private-runtime"),
		func(string) error { return errXrayIntegrity },
	)
	if err == nil || err != errXrayIntegrity {
		t.Fatalf("expected a safe integrity error, got %v", err)
	}
	if stagedPath != "" || stagingDirectory != "" {
		t.Fatalf("failed staging returned usable paths: %q %q", stagedPath, stagingDirectory)
	}
	entries, err := os.ReadDir(filepath.Join(root, "private-runtime"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed staging left files behind: %#v", entries)
	}
}

func TestStageVerifiedXrayBinaryCleansUpAfterCopyFailure(t *testing.T) {
	root := t.TempDir()
	stagingRoot := filepath.Join(root, "private-runtime")

	stagedPath, stagingDirectory, err := stageVerifiedXrayBinary(
		filepath.Join(root, "missing-xray.exe"),
		stagingRoot,
		func(string) error {
			t.Fatal("verifier ran after the source copy failed")
			return nil
		},
	)
	if err == nil || err != errXrayIntegrity {
		t.Fatalf("expected a safe staging error, got %v", err)
	}
	if stagedPath != "" || stagingDirectory != "" {
		t.Fatalf("failed staging returned usable paths: %q %q", stagedPath, stagingDirectory)
	}
	entries, err := os.ReadDir(stagingRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("copy failure left staging data behind: %#v", entries)
	}
}
