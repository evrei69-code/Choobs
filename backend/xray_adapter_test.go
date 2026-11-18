package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const xraySyntheticUUID = "123e4567-e89b-12d3-a456-426614174000"
const xraySyntheticPublicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func parseXrayProfile(t *testing.T, query string) VLESSProfile {
	t.Helper()
	profile, err := ParseVLESSProfile(ServerInput{
		Protocol: "VLESS",
		Address:  "server.example",
		Port:     443,
		URI:      "vless://" + xraySyntheticUUID + "@server.example:443?" + query,
	})
	if err != nil {
		t.Fatalf("ParseVLESSProfile returned an error: %v", err)
	}
	return profile
}

func generateXrayConfig(t *testing.T, profile VLESSProfile) ([]byte, []string, map[string]any) {
	t.Helper()
	encoded, sensitive, err := (XrayAdapter{}).GenerateConfig(profile, 2081)
	if err != nil {
		t.Fatalf("GenerateConfig returned an error: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("generated config is not valid JSON: %v", err)
	}
	return encoded, sensitive, document
}

func mapValue(t *testing.T, value any) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("expected JSON object, got %#v", value)
	}
	return object
}

func firstArrayObject(t *testing.T, value any) map[string]any {
	t.Helper()
	array, ok := value.([]any)
	if !ok || len(array) == 0 {
		t.Fatalf("expected non-empty JSON array, got %#v", value)
	}
	return mapValue(t, array[0])
}

func assertXrayConfig(t *testing.T, profile VLESSProfile, expectedNetwork string) ([]byte, []string, map[string]any) {
	t.Helper()
	encoded, sensitive, document := generateXrayConfig(t, profile)

	logConfig := mapValue(t, document["log"])
	if logConfig["access"] != "none" || logConfig["error"] != "none" || logConfig["loglevel"] != "none" {
		t.Fatalf("Xray logging is not disabled: %#v", logConfig)
	}

	inbound := firstArrayObject(t, document["inbounds"])
	if inbound["listen"] != "127.0.0.1" || inbound["port"] != float64(2081) ||
		inbound["protocol"] != "http" || inbound["tag"] != "local-proxy" {
		t.Fatalf("unexpected local HTTP proxy inbound: %#v", inbound)
	}

	outbounds, ok := document["outbounds"].([]any)
	if !ok || len(outbounds) != 2 {
		t.Fatalf("expected VLESS and freedom outbounds, got %#v", document["outbounds"])
	}
	proxy := mapValue(t, outbounds[0])
	if proxy["protocol"] != "vless" || proxy["tag"] != "proxy" {
		t.Fatalf("unexpected VLESS outbound: %#v", proxy)
	}
	settings := mapValue(t, proxy["settings"])
	vnext := firstArrayObject(t, settings["vnext"])
	if vnext["address"] != profile.ServerAddress || vnext["port"] != float64(profile.ServerPort) {
		t.Fatalf("server endpoint was not mapped: %#v", vnext)
	}
	user := firstArrayObject(t, vnext["users"])
	if user["id"] != profile.UUID || user["encryption"] != "none" {
		t.Fatalf("VLESS user was not mapped: %#v", user)
	}
	if profile.Flow == "" {
		if _, exists := user["flow"]; exists {
			t.Fatalf("unexpected flow in VLESS user: %#v", user)
		}
	} else if user["flow"] != profile.Flow {
		t.Fatalf("VLESS flow was changed: %#v", user)
	}

	stream := mapValue(t, proxy["streamSettings"])
	if stream["network"] != expectedNetwork || stream["security"] != string(profile.Security) {
		t.Fatalf("transport or security was not mapped: %#v", stream)
	}
	routing := mapValue(t, document["routing"])
	rule := firstArrayObject(t, routing["rules"])
	inboundTags, ok := rule["inboundTag"].([]any)
	if rule["type"] != "field" || rule["outboundTag"] != "proxy" ||
		!ok || len(inboundTags) != 1 || inboundTags[0] != "local-proxy" {
		t.Fatalf("unexpected routing rule: %#v", rule)
	}
	return encoded, sensitive, document
}

func TestXrayAdapterGeneratesEverySupportedTransportSecurityCombination(t *testing.T) {
	tests := []struct {
		name      string
		query     string
		network   string
		security  VLESSSecurity
		transport VLESSTransport
	}{
		{
			name:      "tcp tls",
			query:     "type=tcp&security=tls&sni=front.example&fp=chrome&alpn=h2%2Chttp%2F1.1",
			network:   "tcp",
			security:  VLESSSecurityTLS,
			transport: VLESSTransportTCP,
		},
		{
			name:      "tcp reality",
			query:     "type=tcp&security=reality&sni=front.example&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&spx=%2Fprobe",
			network:   "tcp",
			security:  VLESSSecurityReality,
			transport: VLESSTransportTCP,
		},
		{
			name:      "xhttp tls",
			query:     "type=xhttp&security=tls&sni=front.example&fp=chrome&host=front.example&path=%2Fconnect&mode=packet-up",
			network:   "xhttp",
			security:  VLESSSecurityTLS,
			transport: VLESSTransportXHTTP,
		},
		{
			name:      "xhttp reality",
			query:     "type=xhttp&security=reality&sni=front.example&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&host=front.example&path=%2Fconnect&mode=stream-one",
			network:   "xhttp",
			security:  VLESSSecurityReality,
			transport: VLESSTransportXHTTP,
		},
		{
			name:      "grpc tls",
			query:     "type=grpc&security=tls&sni=front.example&fp=chrome&serviceName=Tunnel&authority=grpc.example",
			network:   "grpc",
			security:  VLESSSecurityTLS,
			transport: VLESSTransportGRPC,
		},
		{
			name:      "grpc reality",
			query:     "type=grpc&security=reality&sni=front.example&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&serviceName=Tunnel&authority=grpc.example",
			network:   "grpc",
			security:  VLESSSecurityReality,
			transport: VLESSTransportGRPC,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile := parseXrayProfile(t, test.query)
			if profile.Transport != test.transport || profile.Security != test.security {
				t.Fatalf("unexpected parsed transport/security: %s", profile)
			}
			_, _, document := assertXrayConfig(t, profile, test.network)
			outbound := firstArrayObject(t, document["outbounds"])
			stream := mapValue(t, outbound["streamSettings"])

			if test.security == VLESSSecurityTLS {
				tlsConfig := mapValue(t, stream["tlsSettings"])
				if tlsConfig["serverName"] != profile.ServerName || tlsConfig["fingerprint"] != profile.Fingerprint {
					t.Fatalf("TLS settings were not mapped: %#v", tlsConfig)
				}
				if profile.Flow != "" && tlsConfig["minVersion"] != "1.3" {
					t.Fatalf("Vision over TLS must require TLS 1.3: %#v", tlsConfig)
				}
				if profile.Flow == "" {
					if _, exists := tlsConfig["minVersion"]; exists {
						t.Fatalf("TLS minimum version changed without Vision flow: %#v", tlsConfig)
					}
				}
				if len(profile.ALPN) != 0 && len(tlsConfig["alpn"].([]any)) != len(profile.ALPN) {
					t.Fatalf("ALPN values were lost: %#v", tlsConfig["alpn"])
				}
			} else {
				if _, exists := stream["tlsSettings"]; exists {
					t.Fatalf("Reality settings unexpectedly changed by TLS minimum version: %#v", stream)
				}
				reality := mapValue(t, stream["realitySettings"])
				for key, expected := range map[string]string{
					"serverName":  profile.ServerName,
					"fingerprint": profile.Fingerprint,
					"publicKey":   profile.PublicKey,
					"shortId":     profile.ShortID,
					"spiderX":     profile.SpiderX,
				} {
					if reality[key] != expected {
						t.Fatalf("Reality field %s was not mapped: %#v", key, reality)
					}
				}
			}
		})
	}
}

func TestXrayAdapterPreservesAllXHTTPModesAndParameters(t *testing.T) {
	for _, mode := range []string{"auto", "packet-up", "stream-up", "stream-one"} {
		t.Run(mode, func(t *testing.T) {
			profile := parseXrayProfile(t,
				"type=xhttp&security=tls&sni=front.example&fp=chrome&host=cdn.example&path=%2Fconnect&mode="+mode)
			_, _, document := assertXrayConfig(t, profile, "xhttp")
			outbound := firstArrayObject(t, document["outbounds"])
			stream := mapValue(t, outbound["streamSettings"])
			xhttp := mapValue(t, stream["xhttpSettings"])
			if xhttp["mode"] != mode || xhttp["host"] != profile.Host || xhttp["path"] != profile.Path {
				t.Fatalf("XHTTP settings were lost or changed: %#v", xhttp)
			}
		})
	}
}

func TestXrayAdapterMapsGRPCMultiModeHostAndAuthority(t *testing.T) {
	profile := parseXrayProfile(t,
		"type=grpc&security=tls&sni=front.example&fp=chrome&serviceName=Tunnel&host=grpc.example&mode=multi")
	profile.Authority = ""
	_, _, document := assertXrayConfig(t, profile, "grpc")
	outbound := firstArrayObject(t, document["outbounds"])
	stream := mapValue(t, outbound["streamSettings"])
	grpc := mapValue(t, stream["grpcSettings"])
	if grpc["authority"] != "grpc.example" || grpc["serviceName"] != "Tunnel" ||
		grpc["multiMode"] != true {
		t.Fatalf("gRPC fields were not mapped to Xray schema: %#v", grpc)
	}
}

func TestXrayAdapterPreservesVisionFlowsOnlyOnSupportedTCPProfiles(t *testing.T) {
	for _, flow := range []string{VLESSFlowVision, VLESSFlowVisionUDP443} {
		for _, security := range []string{"tls", "reality"} {
			t.Run(flow+"/"+security, func(t *testing.T) {
				query := "type=tcp&security=" + security + "&flow=" + flow + "&fp=chrome&sni=front.example"
				if security == "reality" {
					query += "&pbk=" + xraySyntheticPublicKey + "&sid=abcd"
				}
				profile := parseXrayProfile(t, query)
				_, _, document := assertXrayConfig(t, profile, "tcp")
				outbound := firstArrayObject(t, document["outbounds"])
				settings := mapValue(t, outbound["settings"])
				vnext := firstArrayObject(t, settings["vnext"])
				user := firstArrayObject(t, vnext["users"])
				if user["flow"] != flow {
					t.Fatalf("flow was altered: %#v", user)
				}
			})
		}
	}
}

func TestXrayAdapterRejectsUnsupportedCombinationsAndMissingFields(t *testing.T) {
	invalidProfiles := []VLESSProfile{
		parseXrayProfile(t, "type=xhttp&security=tls&flow="+VLESSFlowVision),
		parseXrayProfile(t, "type=tcp&security=reality&fp=chrome&pbk="+xraySyntheticPublicKey+"&sid=abcd&alpn=h2"),
		parseXrayProfile(t, "type=xhttp&security=reality&pbk="+xraySyntheticPublicKey+"&sid=abcd"),
	}
	invalidGRPCMode := parseXrayProfile(t, "type=grpc&security=tls&serviceName=Tunnel")
	invalidGRPCMode.Mode = "stream-up"
	invalidProfiles = append(invalidProfiles, invalidGRPCMode)
	conflictingGRPCHost := parseXrayProfile(t, "type=grpc&security=tls&serviceName=Tunnel")
	conflictingGRPCHost.Host = "one.example"
	conflictingGRPCHost.Authority = "two.example"
	invalidProfiles = append(invalidProfiles, conflictingGRPCHost)
	for _, profile := range invalidProfiles {
		_, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081)
		if !errors.Is(err, ErrXrayConfigUnsupported) && !errors.Is(err, ErrXrayConfigInvalid) {
			t.Fatalf("expected unsupported or invalid profile rejection, got %v", err)
		}
	}

	valid := parseXrayProfile(t, "type=tcp&security=tls&sni=front.example&fp=chrome")
	missing := []struct {
		name   string
		mutate func(*VLESSProfile)
		port   uint16
	}{
		{name: "listen port", mutate: func(*VLESSProfile) {}, port: 0},
		{name: "uuid", mutate: func(profile *VLESSProfile) { profile.UUID = "" }, port: 2081},
		{name: "server address", mutate: func(profile *VLESSProfile) { profile.ServerAddress = "" }, port: 2081},
		{name: "server port", mutate: func(profile *VLESSProfile) { profile.ServerPort = 0 }, port: 2081},
		{name: "server name", mutate: func(profile *VLESSProfile) { profile.ServerName = "" }, port: 2081},
	}
	for _, test := range missing {
		t.Run(test.name, func(t *testing.T) {
			profile := valid
			test.mutate(&profile)
			_, _, err := (XrayAdapter{}).GenerateConfig(profile, test.port)
			if !errors.Is(err, ErrXrayConfigInvalid) {
				t.Fatalf("expected invalid required-field error, got %v", err)
			}
		})
	}
	realityWithoutFingerprint := parseXrayProfile(t,
		"type=tcp&security=reality&pbk="+xraySyntheticPublicKey+"&sid=abcd")
	if _, _, err := (XrayAdapter{}).GenerateConfig(realityWithoutFingerprint, 2081); !errors.Is(err, ErrXrayConfigInvalid) {
		t.Fatalf("Reality without fingerprint should fail validation, got %v", err)
	}

	tlsWithoutFingerprint := parseXrayProfile(t, "type=tcp&security=tls&sni=front.example")
	if _, _, err := (XrayAdapter{}).GenerateConfig(tlsWithoutFingerprint, 2081); err != nil {
		t.Fatalf("TLS without optional fingerprint should be supported: %v", err)
	}
}

func TestXrayAdapterErrorsAndRedactionValuesDoNotExposeCredentials(t *testing.T) {
	profile := parseXrayProfile(t,
		"type=tcp&security=reality&fp=chrome&pbk="+xraySyntheticPublicKey+"&sid=deadbeef")
	encoded, sensitive, err := (XrayAdapter{}).GenerateConfig(profile, 2081)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), profile.UUID) {
		t.Fatal("the runtime config must contain the UUID for core use")
	}
	for _, secret := range []string{profile.UUID, profile.PublicKey, profile.ShortID} {
		found := false
		for _, value := range sensitive {
			if value == secret {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("secret is missing from log redaction values: %q", secret)
		}
	}

	profile.PublicKey = "synthetic-public-key-secret"
	_, _, err = (XrayAdapter{}).GenerateConfig(profile, 2081)
	if err == nil || strings.Contains(err.Error(), profile.UUID) ||
		strings.Contains(err.Error(), "synthetic-public-key-secret") ||
		strings.Contains(err.Error(), profile.ShortID) {
		t.Fatalf("validation error exposed profile credentials: %v", err)
	}
}

func TestXrayAdapterRequiresUnpaddedRawBase64URLRealityPublicKey(t *testing.T) {
	profile := parseXrayProfile(t,
		"type=tcp&security=reality&fp=chrome&pbk="+xraySyntheticPublicKey+"&sid=abcd")
	encoded, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081)
	if err != nil {
		t.Fatalf("unpadded Reality public key should be accepted: %v", err)
	}
	if !strings.Contains(string(encoded), `"publicKey": "`+xraySyntheticPublicKey+`"`) {
		t.Fatal("generated config did not preserve the Xray-compatible public key")
	}

	profile.PublicKey += "="
	if _, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081); !errors.Is(err, ErrXrayConfigInvalid) {
		t.Fatalf("padded Reality public key should be rejected: %v", err)
	}
	if core, err := (CoreSelector{}).Select(profile); err == nil && core == CoreXray {
		t.Fatal("Selector routed a padded Reality public key to Xray")
	}

	profile.PublicKey = "not-valid-base64url!"
	if _, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081); !errors.Is(err, ErrXrayConfigInvalid) {
		t.Fatalf("invalid Base64URL Reality public key should be rejected: %v", err)
	}
}

func TestCoreSelectorOnlySelectsXrayProfilesAcceptedByAdapter(t *testing.T) {
	selectedProfiles := []string{
		"type=xhttp&security=tls&mode=auto",
		"type=xhttp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&mode=stream-one",
		"type=grpc&security=tls&serviceName=Tunnel&mode=multi",
		"type=grpc&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd",
		"type=tcp&security=tls&flow=" + VLESSFlowVision,
		"type=tcp&security=tls&flow=" + VLESSFlowVisionUDP443,
		"type=tcp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey +
			"&sid=abcd&flow=" + VLESSFlowVisionUDP443,
		"type=tcp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey +
			"&sid=abcd&spx=%2Fprobe&flow=" + VLESSFlowVision,
	}
	for _, query := range selectedProfiles {
		profile := parseXrayProfile(t, query)
		core, err := (CoreSelector{}).Select(profile)
		if err != nil || core != CoreXray {
			t.Fatalf("expected Xray selection for %s, got %q, %v", profile, core, err)
		}
		if _, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081); err != nil {
			t.Fatalf("Selector chose Xray for a profile rejected by the adapter: %s: %v", profile, err)
		}
	}
}

func TestCoreSelectorDoesNotSelectXrayForAdapterRejectedProfiles(t *testing.T) {
	rejectedProfiles := []string{
		"type=xhttp&security=none&mode=auto",
		"type=grpc&security=none&mode=multi",
		"type=xhttp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&alpn=h2",
		"type=grpc&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&alpn=h2",
		"type=tcp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey + "&sid=abcd&alpn=h2",
		"type=tcp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey +
			"&sid=abcd&flow=" + VLESSFlowVisionUDP443 + "&alpn=h2",
		"type=xhttp&security=reality&fp=chrome&pbk=" + xraySyntheticPublicKey + "=&sid=abcd",
	}
	for _, query := range rejectedProfiles {
		profile := parseXrayProfile(t, query)
		if _, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081); err == nil {
			t.Fatalf("expected adapter rejection for %s", profile)
		}
		core, err := (CoreSelector{}).Select(profile)
		if err == nil && core == CoreXray {
			t.Fatalf("Selector routed an adapter-rejected profile to Xray: %s", profile)
		}
	}
}

func TestXrayAdapterConfigWithPinnedXrayBinaryWhenAvailable(t *testing.T) {
	binary, err := exec.LookPath("xray")
	if err != nil {
		t.Skip("Xray binary is not available in PATH")
	}
	versionOutput, err := exec.Command(binary, "version").CombinedOutput()
	if err != nil || !strings.Contains(string(versionOutput), "24.11.30") {
		t.Skip("available Xray binary is not confirmed as version 24.11.30")
	}

	profile := parseXrayProfile(t,
		"type=xhttp&security=reality&sni=front.example&fp=chrome&pbk="+
			xraySyntheticPublicKey+"&sid=abcd&host=cdn.example&path=%2Fconnect&mode=stream-up")
	encoded, _, err := (XrayAdapter{}).GenerateConfig(profile, 2081)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "xray.json")
	if err := os.WriteFile(configPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "run", "-test", "-config", configPath)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Xray 24.11.30 rejected the generated configuration (output suppressed, %d bytes)", len(output))
	}
}
