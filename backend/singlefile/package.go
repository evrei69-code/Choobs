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
	"path/filepath"
	"sort"
	"strings"
)

const (
	manifestName = ".choobs-runtime-manifest.json"
	maxFiles     = 10000
	maxPayload   = int64(2 << 30)
)

type Manifest struct {
	Files map[string]string `json:"files"`
}

func CreatePayload(sourceDirectory, destination string) (string, error) {
	absoluteSource, err := filepath.Abs(sourceDirectory)
	if err != nil {
		return "", fmt.Errorf("resolve payload source: %w", err)
	}
	output, err := os.Create(destination)
	if err != nil {
		return "", fmt.Errorf("create payload archive: %w", err)
	}
	zipWriter := zip.NewWriter(output)
	manifest := Manifest{Files: make(map[string]string)}
	filePaths := make([]string, 0)

	err = filepath.Walk(absoluteSource, func(filePath string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("payload contains a symbolic link: %s", filepath.Base(filePath))
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("payload contains a non-regular file: %s", filepath.Base(filePath))
		}
		relative, relErr := filepath.Rel(absoluteSource, filePath)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		if relative == "" || strings.Contains(relative, "\\") || relative == manifestName {
			return fmt.Errorf("payload contains a reserved or invalid file path")
		}
		filePaths = append(filePaths, relative)
		return nil
	})
	if err == nil && (len(filePaths) == 0 || len(filePaths) > maxFiles) {
		err = fmt.Errorf("payload file count is outside the supported range")
	}
	sort.Strings(filePaths)
	var totalSize int64
	for _, relative := range filePaths {
		if err != nil {
			break
		}
		filePath := filepath.Join(absoluteSource, filepath.FromSlash(relative))
		info, statErr := os.Stat(filePath)
		if statErr != nil {
			err = statErr
			break
		}
		totalSize += info.Size()
		if totalSize > maxPayload {
			err = fmt.Errorf("payload is larger than the supported limit")
			break
		}
		file, openErr := os.Open(filePath)
		if openErr != nil {
			err = openErr
			break
		}
		hash := sha256.New()
		entry, createErr := zipWriter.Create(relative)
		if createErr == nil {
			_, createErr = io.Copy(io.MultiWriter(entry, hash), file)
		}
		closeErr := file.Close()
		if createErr != nil {
			err = createErr
		} else if closeErr != nil {
			err = closeErr
		} else {
			manifest.Files[relative] = hex.EncodeToString(hash.Sum(nil))
		}
	}
	if err == nil {
		manifestBytes, marshalErr := json.Marshal(manifest)
		if marshalErr != nil {
			err = marshalErr
		} else {
			var entry io.Writer
			entry, err = zipWriter.Create(manifestName)
			if err == nil {
				_, err = entry.Write(manifestBytes)
			}
		}
	}
	if closeErr := zipWriter.Close(); err == nil {
		err = closeErr
	}
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", fmt.Errorf("create payload archive: %w", err)
	}
	return FileSHA256(destination)
}

func FileSHA256(filePath string) (string, error) {
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

func AppendPayload(stubPath, payloadPath, outputPath, expectedHash string) error {
	actualHash, err := FileSHA256(payloadPath)
	if err != nil {
		return fmt.Errorf("hash payload: %w", err)
	}
	if !strings.EqualFold(actualHash, expectedHash) {
		return errors.New("payload checksum did not match the bootstrap build")
	}
	stub, err := os.Open(stubPath)
	if err != nil {
		return fmt.Errorf("open bootstrap executable: %w", err)
	}
	defer stub.Close()
	payload, err := os.Open(payloadPath)
	if err != nil {
		return fmt.Errorf("open payload archive: %w", err)
	}
	defer payload.Close()
	output, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("create single-file executable: %w", err)
	}
	if _, err = io.Copy(output, stub); err == nil {
		_, err = io.Copy(output, payload)
	}
	if err == nil {
		_, err = output.Write(encodeFooter(actualHash, fileSize(payloadPath)))
	}
	closeErr := output.Close()
	if err != nil {
		return fmt.Errorf("append payload to bootstrap: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close single-file executable: %w", closeErr)
	}
	return nil
}

func fileSize(filePath string) int64 {
	info, err := os.Stat(filePath)
	if err != nil {
		return -1
	}
	return info.Size()
}
