package singlefile

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const footerMagic = "CHOOBS1F"

const footerSize = 8 + 8 + sha256.Size

type payloadFooter struct {
	Size int64
	Hash string
}

func encodeFooter(hash string, size int64) []byte {
	footer := make([]byte, footerSize)
	copy(footer[:8], footerMagic)
	for index := 0; index < 8; index++ {
		footer[8+index] = byte(uint64(size) >> (8 * index))
	}
	decoded, _ := hex.DecodeString(hash)
	copy(footer[16:], decoded)
	return footer
}

func readFooter(executablePath, expectedHash string) (*zip.Reader, *os.File, error) {
	file, err := os.Open(executablePath)
	if err != nil {
		return nil, nil, fmt.Errorf("open Choobs executable: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("inspect Choobs executable: %w", err)
	}
	if info.Size() < footerSize {
		file.Close()
		return nil, nil, errors.New("Choobs executable does not contain an embedded runtime")
	}
	footerBytes := make([]byte, footerSize)
	if _, err := file.ReadAt(footerBytes, info.Size()-footerSize); err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("read embedded runtime footer: %w", err)
	}
	if string(footerBytes[:8]) != footerMagic {
		file.Close()
		return nil, nil, errors.New("Choobs executable has an invalid embedded runtime footer")
	}
	size := int64(0)
	for index := 0; index < 8; index++ {
		size |= int64(footerBytes[8+index]) << (8 * index)
	}
	if size <= 0 || size > maxPayload || size > info.Size()-footerSize {
		file.Close()
		return nil, nil, errors.New("Choobs executable has an invalid embedded runtime size")
	}
	hash := hex.EncodeToString(footerBytes[16:])
	if expectedHash == "" || !strings.EqualFold(hash, expectedHash) {
		file.Close()
		return nil, nil, errors.New("Choobs embedded runtime does not match this bootstrap version")
	}
	offset := info.Size() - footerSize - size
	payloadReader := io.NewSectionReader(file, offset, size)
	actualHash := sha256.New()
	if _, err := io.Copy(actualHash, payloadReader); err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("verify embedded runtime: %w", err)
	}
	if !strings.EqualFold(hex.EncodeToString(actualHash.Sum(nil)), expectedHash) {
		file.Close()
		return nil, nil, errors.New("Choobs embedded runtime failed its integrity check")
	}
	readerAt := io.NewSectionReader(file, offset, size)
	archive, err := zip.NewReader(readerAt, size)
	if err != nil {
		file.Close()
		return nil, nil, fmt.Errorf("open embedded runtime archive: %w", err)
	}
	return archive, file, nil
}

func embeddedManifest(archive *zip.Reader) (Manifest, error) {
	for _, entry := range archive.File {
		if entry.Name != manifestName {
			continue
		}
		if entry.UncompressedSize64 > 4<<20 {
			return Manifest{}, errors.New("embedded runtime manifest is too large")
		}
		reader, err := entry.Open()
		if err != nil {
			return Manifest{}, fmt.Errorf("open embedded runtime manifest: %w", err)
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, 4<<20+1))
		closeErr := reader.Close()
		if readErr != nil {
			return Manifest{}, fmt.Errorf("read embedded runtime manifest: %w", readErr)
		}
		if closeErr != nil {
			return Manifest{}, fmt.Errorf("close embedded runtime manifest: %w", closeErr)
		}
		var manifest Manifest
		if err := json.Unmarshal(data, &manifest); err != nil || len(manifest.Files) == 0 || len(manifest.Files) > maxFiles {
			return Manifest{}, errors.New("embedded runtime manifest is invalid")
		}
		return manifest, nil
	}
	return Manifest{}, errors.New("embedded runtime manifest is missing")
}

func validateArchive(archive *zip.Reader, manifest Manifest) error {
	if len(archive.File) != len(manifest.Files)+1 {
		return errors.New("embedded runtime archive has an unexpected file list")
	}
	var totalSize uint64
	seen := make(map[string]bool, len(archive.File))
	for _, entry := range archive.File {
		name := entry.Name
		if name == manifestName {
			if seen[name] {
				return errors.New("embedded runtime archive contains duplicate files")
			}
			seen[name] = true
			continue
		}
		if !safeArchivePath(name) || seen[name] || entry.FileInfo().IsDir() || !entry.Mode().IsRegular() {
			return errors.New("embedded runtime archive contains an unsafe file entry")
		}
		seen[name] = true
		expected, ok := manifest.Files[name]
		if !ok || len(expected) != sha256.Size*2 {
			return errors.New("embedded runtime archive does not match its manifest")
		}
		if _, err := hex.DecodeString(expected); err != nil {
			return errors.New("embedded runtime manifest contains an invalid checksum")
		}
		totalSize += entry.UncompressedSize64
		if totalSize > uint64(maxPayload) {
			return errors.New("embedded runtime expands beyond the supported size")
		}
	}
	for name := range manifest.Files {
		if !safeArchivePath(name) || !seen[name] {
			return errors.New("embedded runtime manifest contains an unexpected path")
		}
	}
	return nil
}

func safeArchivePath(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") {
		return false
	}
	cleaned := filepath.Clean(filepath.FromSlash(name))
	return cleaned != "." && cleaned != ".." &&
		!strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) &&
		filepath.ToSlash(cleaned) == name
}

func verifyDirectory(directory string, manifest Manifest) error {
	for name, expected := range manifest.Files {
		filePath := filepath.Join(directory, filepath.FromSlash(name))
		info, err := os.Lstat(filePath)
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("an extracted runtime file is missing or invalid")
		}
		actual, err := FileSHA256(filePath)
		if err != nil || !strings.EqualFold(actual, expected) {
			return errors.New("an extracted runtime file failed its integrity check")
		}
	}
	if err := verifyRequiredFiles(manifest); err != nil {
		return err
	}
	return nil
}

func extractArchive(archive *zip.Reader, manifest Manifest, destination string) error {
	if err := validateArchive(archive, manifest); err != nil {
		return err
	}
	if err := os.MkdirAll(destination, 0700); err != nil {
		return fmt.Errorf("create runtime staging directory: %w", err)
	}
	for _, entry := range archive.File {
		if entry.Name == manifestName {
			continue
		}
		filePath := filepath.Join(destination, filepath.FromSlash(entry.Name))
		if err := os.MkdirAll(filepath.Dir(filePath), 0700); err != nil {
			return fmt.Errorf("create runtime directory: %w", err)
		}
		reader, err := entry.Open()
		if err != nil {
			return fmt.Errorf("open embedded runtime file: %w", err)
		}
		output, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			reader.Close()
			return fmt.Errorf("create extracted runtime file: %w", err)
		}
		hash := sha256.New()
		_, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(reader, int64(entry.UncompressedSize64)+1))
		readerErr := reader.Close()
		outputErr := output.Close()
		if copyErr != nil || readerErr != nil || outputErr != nil {
			return errors.New("could not extract an embedded runtime file")
		}
		if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), manifest.Files[entry.Name]) {
			return errors.New("an embedded runtime file failed its integrity check")
		}
		if int64(entry.FileInfo().Size()) != int64(entry.UncompressedSize64) {
			return errors.New("an embedded runtime file had an unexpected size")
		}
	}
	if err := verifyDirectory(destination, manifest); err != nil {
		return err
	}
	return nil
}

func EnsureRuntime(archive *zip.Reader, expectedHash, applicationVersion, userDirectory string) (string, error) {
	if len(expectedHash) < 16 || applicationVersion == "" {
		return "", errors.New("Choobs runtime identity is invalid")
	}
	manifest, err := embeddedManifest(archive)
	if err != nil {
		return "", err
	}
	if err := validateArchive(archive, manifest); err != nil {
		return "", err
	}
	runtimeRoot := filepath.Join(userDirectory, "Choobs", "runtime")
	if err := os.MkdirAll(runtimeRoot, 0700); err != nil {
		return "", fmt.Errorf("create Choobs runtime directory: %w", err)
	}
	destination := filepath.Join(runtimeRoot, fmt.Sprintf("%s-%s", applicationVersion, expectedHash[:16]))
	if err := verifyDirectory(destination, manifest); err == nil {
		return destination, nil
	}

	staging, err := os.MkdirTemp(runtimeRoot, ".extract-*")
	if err != nil {
		return "", fmt.Errorf("create runtime staging directory: %w", err)
	}
	defer os.RemoveAll(staging)
	if err := extractArchive(archive, manifest, staging); err != nil {
		return "", err
	}
	if _, err := os.Stat(destination); err == nil {
		backup := destination + ".invalid-" + time.Now().UTC().Format("20060102150405.000000000")
		if err := os.Rename(destination, backup); err != nil {
			return "", errors.New("an invalid older runtime could not be replaced safely")
		}
	}
	if err := os.Rename(staging, destination); err != nil {
		if verifyErr := verifyDirectory(destination, manifest); verifyErr == nil {
			return destination, nil
		}
		return "", fmt.Errorf("activate extracted runtime: %w", err)
	}
	if err := verifyDirectory(destination, manifest); err != nil {
		return "", err
	}
	return destination, nil
}

func Run(expectedHash, applicationVersion string) error {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return errors.New("this Choobs portable executable requires Windows x64")
	}
	executablePath, err := os.Executable()
	if err != nil {
		return errors.New("could not locate the Choobs executable")
	}
	archive, archiveFile, err := readFooter(executablePath, expectedHash)
	if err != nil {
		return err
	}
	defer archiveFile.Close()
	userDirectory := os.Getenv("LOCALAPPDATA")
	if userDirectory == "" {
		userDirectory, err = os.UserConfigDir()
		if err != nil {
			return errors.New("could not locate the current user's application data directory")
		}
	}
	runtimeDirectory, err := EnsureRuntime(archive, expectedHash, applicationVersion, userDirectory)
	if err != nil {
		return err
	}
	if err := archiveFile.Close(); err != nil {
		return errors.New("could not close the verified Choobs runtime archive")
	}
	applicationPath := filepath.Join(runtimeDirectory, "Choobs.exe")
	command := exec.Command(applicationPath, os.Args[1:]...)
	command.Dir = runtimeDirectory
	if err := command.Start(); err != nil {
		return errors.New("could not start the extracted Choobs application")
	}
	if err := command.Wait(); err != nil {
		return fmt.Errorf("Choobs application exited with an error: %w", err)
	}
	return nil
}

func VerifyArchiveFile(archivePath string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open packaged runtime archive: %w", err)
	}
	defer reader.Close()
	manifest, err := embeddedManifest(&reader.Reader)
	if err != nil {
		return err
	}
	if err := validateArchive(&reader.Reader, manifest); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp("", "choobs-runtime-smoke-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	if err := extractArchive(&reader.Reader, manifest, temporary); err != nil {
		return err
	}
	return verifyDirectory(temporary, manifest)
}

func VerifyExecutable(executablePath, expectedHash, expectedSingBoxHash string) error {
	archive, archiveFile, err := readFooter(executablePath, expectedHash)
	if err != nil {
		return err
	}
	defer archiveFile.Close()
	manifest, err := embeddedManifest(archive)
	if err != nil {
		return err
	}
	if !strings.EqualFold(manifest.Files["resources/core/bin/sing-box.exe"], expectedSingBoxHash) {
		return errors.New("embedded sing-box binary does not match the verified legacy build")
	}
	if err := validateArchive(archive, manifest); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp("", "choobs-singlefile-smoke-*")
	if err != nil {
		return fmt.Errorf("create single-file smoke directory: %w", err)
	}
	defer os.RemoveAll(temporary)
	if err := extractArchive(archive, manifest, temporary); err != nil {
		return err
	}
	return verifyDirectory(temporary, manifest)
}

func verifyRequiredFiles(manifest Manifest) error {
	required := []string{
		"Choobs.exe",
		"resources/app.asar",
		"resources/backend/choobs-core-manager.exe",
		"resources/core/bin/sing-box.exe",
	}
	for _, name := range required {
		if _, ok := manifest.Files[name]; !ok {
			return errors.New("embedded runtime is missing a required application component")
		}
	}
	return nil
}
