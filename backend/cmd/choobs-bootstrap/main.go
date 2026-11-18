package main

import (
	"fmt"
	"os"

	"choobs/backend/singlefile"
)

var expectedPayloadHash = ""
var expectedXraySHA256 = ""
var applicationVersion = "0.1.0"

func main() {
	if err := singlefile.Run(expectedPayloadHash, expectedXraySHA256, applicationVersion); err != nil {
		showError("Choobs could not start. " + err.Error())
		os.Exit(1)
	}
}

func showError(message string) {
	if err := showWindowsError(message); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, message)
	}
}
