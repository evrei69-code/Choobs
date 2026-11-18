package singlefile

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func createTestRuntime(t *testing.T, root string) {
	t.Helper()
	files := map[string]string{
		"Choobs.exe":         "synthetic electron executable",
		"resources/app.asar": "synthetic electron app",
		"resources/backend/choobs-core-manager.exe": "synthetic core manager",
		"resources/core/bin/sing-box.exe":           "synthetic sing-box",
		"resources/core/bin/xray.exe":               "synthetic xray",
	}
	for name, content := range files {
		filePath := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filePath, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func testXraySHA256() string {
	hash := sha256.Sum256([]byte("synthetic xray"))
	return hex.EncodeToString(hash[:])
}

func openArchive(t *testing.T, archivePath string) *zip.Reader {
	t.Helper()
	file, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		t.Fatal(err)
	}
	return archive
}

func TestPayloadArchiveExtractsAndReusesVerifiedRuntime(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	createTestRuntime(t, source)
	archivePath := filepath.Join(root, "payload.zip")
	hash, err := CreatePayload(source, archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := openArchive(t, archivePath)
	userDirectory := filepath.Join(root, "user")

	first, err := EnsureRuntime(archive, hash, testXraySHA256(), "0.1.0", userDirectory)
	if err != nil {
		t.Fatal(err)
	}
	second, err := EnsureRuntime(archive, hash, testXraySHA256(), "0.1.0", userDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("runtime path changed on reuse: %q != %q", first, second)
	}
	if err := verifyDirectory(first, mustManifest(t, archive)); err != nil {
		t.Fatal(err)
	}
}

func TestDamagedRuntimeIsReplacedWithVerifiedFiles(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	createTestRuntime(t, source)
	archivePath := filepath.Join(root, "payload.zip")
	hash, err := CreatePayload(source, archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := openArchive(t, archivePath)
	userDirectory := filepath.Join(root, "user")
	runtimePath, err := EnsureRuntime(archive, hash, testXraySHA256(), "0.1.0", userDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimePath, "Choobs.exe"), []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}
	repaired, err := EnsureRuntime(archive, hash, testXraySHA256(), "0.1.0", userDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyDirectory(repaired, mustManifest(t, archive)); err != nil {
		t.Fatal(err)
	}
}

func TestExecutablePayloadFooterAndIntegrity(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	createTestRuntime(t, source)
	archivePath := filepath.Join(root, "payload.zip")
	hash, err := CreatePayload(source, archivePath)
	if err != nil {
		t.Fatal(err)
	}
	stubPath := filepath.Join(root, "stub.exe")
	if err := os.WriteFile(stubPath, []byte("MZ synthetic bootstrap stub"), 0600); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "Choobs.exe")
	if err := AppendPayload(stubPath, archivePath, executable, hash); err != nil {
		t.Fatal(err)
	}
	singBoxHash := sha256.Sum256([]byte("synthetic sing-box"))
	expectedSingBoxHash := hex.EncodeToString(singBoxHash[:])
	if err := VerifyExecutable(executable, hash, expectedSingBoxHash, testXraySHA256()); err != nil {
		t.Fatal(err)
	}
	if err := VerifyExecutable(executable, "0000000000000000", expectedSingBoxHash, testXraySHA256()); err == nil {
		t.Fatal("expected payload hash mismatch")
	}
	if err := VerifyExecutable(executable, hash, expectedSingBoxHash, strings.Repeat("0", 64)); err == nil {
		t.Fatal("expected incorrect Xray checksum to be rejected")
	}
}

func TestRuntimeRejectsPayloadWithUnexpectedXrayChecksum(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(source, 0700); err != nil {
		t.Fatal(err)
	}
	createTestRuntime(t, source)
	archivePath := filepath.Join(root, "payload.zip")
	_, err := CreatePayload(source, archivePath)
	if err != nil {
		t.Fatal(err)
	}

	if err := VerifyArchiveFile(archivePath, testXraySHA256()); err != nil {
		t.Fatalf("valid portable payload failed Xray checksum verification: %v", err)
	}
	if err := VerifyArchiveFile(archivePath, strings.Repeat("0", 64)); err == nil {
		t.Fatal("expected archive with unexpected Xray checksum to be rejected")
	}
	if _, err := EnsureRuntime(openArchive(t, archivePath), strings.Repeat("a", 64), strings.Repeat("0", 64), "0.1.0", filepath.Join(root, "user")); err == nil {
		t.Fatal("expected runtime extraction with unexpected Xray checksum to be rejected")
	}
}

func TestRuntimeArchiveRequiresXrayExecutable(t *testing.T) {
	manifest := Manifest{Files: map[string]string{
		"Choobs.exe":         "a",
		"resources/app.asar": "b",
		"resources/backend/choobs-core-manager.exe": "c",
		"resources/core/bin/sing-box.exe":           "d",
	}}
	if err := verifyRequiredFiles(manifest); err == nil {
		t.Fatal("expected required Xray executable to be enforced")
	}
}

func TestArchiveRejectsPathTraversal(t *testing.T) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.Create("../outside.txt")
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("outside")
	_, _ = entry.Write(content)
	hash := sha256.Sum256(content)
	manifestBytes := []byte(`{"files":{"../outside.txt":"` + hex.EncodeToString(hash[:]) + `"}}`)
	entry, err = writer.Create(manifestName)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write(manifestBytes)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := embeddedManifest(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateArchive(archive, manifest); err == nil {
		t.Fatal("expected unsafe archive path to be rejected")
	}
}

func mustManifest(t *testing.T, archive *zip.Reader) Manifest {
	t.Helper()
	manifest, err := embeddedManifest(archive)
	if err != nil {
		t.Fatal(err)
	}
	return manifest
}
