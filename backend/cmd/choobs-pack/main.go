package main

import (
	"flag"
	"fmt"
	"os"

	"choobs/backend/singlefile"
)

func main() {
	if len(os.Args) < 2 {
		fail("expected create, append, or verify command")
	}
	switch os.Args[1] {
	case "create":
		create(os.Args[2:])
	case "append":
		appendPayload(os.Args[2:])
	case "verify":
		verify(os.Args[2:])
	case "verify-executable":
		verifyExecutable(os.Args[2:])
	default:
		fail("unsupported packager command")
	}
}

func create(args []string) {
	flags := flag.NewFlagSet("create", flag.ExitOnError)
	source := flags.String("source-dir", "", "built Electron application directory")
	output := flags.String("output", "", "temporary ZIP payload output")
	_ = flags.Parse(args)
	if *source == "" || *output == "" {
		fail("create requires source-dir and output")
	}
	hash, err := singlefile.CreatePayload(*source, *output)
	if err != nil {
		fail(err.Error())
	}
	fmt.Println(hash)
}

func appendPayload(args []string) {
	flags := flag.NewFlagSet("append", flag.ExitOnError)
	stub := flags.String("stub", "", "compiled Windows bootstrap executable")
	payload := flags.String("payload", "", "verified payload ZIP")
	output := flags.String("output", "", "single-file executable output")
	hash := flags.String("sha256", "", "expected payload SHA-256")
	_ = flags.Parse(args)
	if *stub == "" || *payload == "" || *output == "" || *hash == "" {
		fail("append requires stub, payload, output, and sha256")
	}
	if err := singlefile.AppendPayload(*stub, *payload, *output, *hash); err != nil {
		fail(err.Error())
	}
}

func verify(args []string) {
	flags := flag.NewFlagSet("verify", flag.ExitOnError)
	payload := flags.String("payload", "", "runtime payload ZIP to verify and extract")
	_ = flags.Parse(args)
	if *payload == "" {
		fail("verify requires payload")
	}
	if err := singlefile.VerifyArchiveFile(*payload); err != nil {
		fail(err.Error())
	}
	fmt.Println("embedded runtime archive verified and extracted successfully")
}

func verifyExecutable(args []string) {
	flags := flag.NewFlagSet("verify-executable", flag.ExitOnError)
	executable := flags.String("executable", "", "single-file Choobs executable")
	hash := flags.String("sha256", "", "expected embedded payload SHA-256")
	singBoxHash := flags.String("sing-box-sha256", "", "expected sing-box SHA-256")
	_ = flags.Parse(args)
	if *executable == "" || *hash == "" || *singBoxHash == "" {
		fail("verify-executable requires executable, sha256, and sing-box-sha256")
	}
	if err := singlefile.VerifyExecutable(*executable, *hash, *singBoxHash); err != nil {
		fail(err.Error())
	}
	fmt.Println("single-file executable payload and required runtime files verified")
}

func fail(message string) {
	_, _ = fmt.Fprintln(os.Stderr, "choobs packager:", message)
	os.Exit(1)
}
