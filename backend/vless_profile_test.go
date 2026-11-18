package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

const syntheticVLESSUUID = "123e4567-e89b-12d3-a456-426614174000"
const syntheticRealityKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func profileServer(uri string) ServerInput {
	return ServerInput{
		Protocol: "VLESS",
		Address:  "example.com",
		Port:     443,
		URI:      uri,
	}
}

func mustParseVLESSProfile(t *testing.T, uri string) VLESSProfile {
	t.Helper()
	profile, err := ParseVLESSProfile(profileServer(uri))
	if err != nil {
		t.Fatalf("ParseVLESSProfile returned an error: %v", err)
	}
	return profile
}

func TestParseVLESSProfileSupportsRequestedParameters(t *testing.T) {
	uri := "vless://" + syntheticVLESSUUID + "@example.com:443" +
		"?encryption=none&%74ype=xhttp&security=reality&flow=&mode=stream-one" +
		"&host=front.example&path=%2Fconnect&serviceName=service&spiderX=%2Fprobe" +
		"&serverName=front.example&fp=chrome&publicKey=" + syntheticRealityKey + "&shortId=abcd"
	profile := mustParseVLESSProfile(t, uri)
	if profile.Transport != VLESSTransportXHTTP || profile.Security != VLESSSecurityReality ||
		profile.Mode != "stream-one" || profile.Host != "front.example" ||
		profile.Path != "/connect" || profile.ServiceName != "service" ||
		profile.SpiderX != "/probe" || profile.ServerName != "front.example" ||
		profile.Fingerprint != "chrome" || profile.PublicKey != syntheticRealityKey ||
		profile.ShortID != "abcd" {
		t.Fatalf("parsed VLESS profile did not preserve requested fields: %s", profile)
	}
}

func TestParseVLESSProfileSupportsTransportDefaultsAndAliases(t *testing.T) {
	profile := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?TYPE=TCP&SECURITY=TLS"+
			"&sni=front.example")
	if profile.Transport != VLESSTransportTCP || profile.Security != VLESSSecurityTLS {
		t.Fatalf("unexpected parsed defaults: %s", profile)
	}

	// Unknown parameter names are rejected without being echoed.
	if _, err := ParseVLESSProfile(profileServer(
		"vless://" + syntheticVLESSUUID + "@example.com:443?server_name=secret.example",
	)); !errors.Is(err, ErrUnsupportedVLESSParameter) {
		t.Fatalf("expected unknown parameter rejection, got %v", err)
	}

	aliased := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?security=tls&sni=front.example&serverName=front.example"+
			"&fingerprint=chrome")
	if aliased.ServerName != "front.example" || aliased.Fingerprint != "chrome" {
		t.Fatalf("equivalent aliases were not normalized: %s", aliased)
	}

	spx := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?security=reality&pbk="+
			syntheticRealityKey+"&sid=abcd&spx=%2Fprobe")
	spiderX := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?security=reality&pbk="+
			syntheticRealityKey+"&sid=abcd&spiderX=%2Fprobe")
	if spx.SpiderX != "/probe" || spiderX.SpiderX != "/probe" {
		t.Fatalf("spx and spiderX aliases were not normalized")
	}
	bothAliases := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?security=reality&pbk="+
			syntheticRealityKey+"&sid=abcd&spx=%2Fprobe&spiderX=%2Fprobe")
	if bothAliases.SpiderX != "/probe" {
		t.Fatal("matching spx and spiderX values should be accepted")
	}
}

func TestCoreSelectorKeepsSupportedSingBoxCombinations(t *testing.T) {
	tests := []struct {
		name string
		uri  string
	}{
		{
			name: "tcp without security",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp",
		},
		{
			name: "tcp with tls",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=tls&sni=front.example",
		},
		{
			name: "tcp with reality and vision",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=reality" +
				"&flow=xtls-rprx-vision&pbk=" + syntheticRealityKey + "&sid=abcd",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile := mustParseVLESSProfile(t, test.uri)
			core, err := (CoreSelector{}).Select(profile)
			if err != nil || core != CoreSingBox {
				t.Fatalf("expected sing-box selection, got %q, %v", core, err)
			}
		})
	}
}

func TestCoreSelectorRoutesSupportedXHTTPAndGRPCToXray(t *testing.T) {
	tests := []struct {
		name string
		uri  string
	}{
		{
			name: "xhttp auto tls",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&security=tls&mode=auto",
		},
		{
			name: "xhttp reality stream-one",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&security=reality&mode=stream-one" +
				"&pbk=" + syntheticRealityKey + "&sid=abcd&fp=chrome",
		},
		{
			name: "grpc tls",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&security=tls&serviceName=service",
		},
		{
			name: "grpc reality",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&security=reality" +
				"&pbk=" + syntheticRealityKey + "&sid=abcd&fp=chrome",
		},
		{
			name: "tcp vision with tls",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=tls&flow=xtls-rprx-vision",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile := mustParseVLESSProfile(t, test.uri)
			core, err := (CoreSelector{}).Select(profile)
			if err != nil || core != CoreXray {
				t.Fatalf("expected Xray selection, got %q, %v", core, err)
			}
		})
	}
}

func TestCoreSelectorSupportsAllXHTTPModes(t *testing.T) {
	for _, mode := range []string{"auto", "packet-up", "stream-up", "stream-one"} {
		t.Run(mode, func(t *testing.T) {
			profile := mustParseVLESSProfile(t,
				"vless://"+syntheticVLESSUUID+"@example.com:443?type=xhttp&security=tls&mode="+mode)
			core, err := (CoreSelector{}).Select(profile)
			if err != nil || core != CoreXray {
				t.Fatalf("expected Xray selection for XHTTP %s, got %q, %v", mode, core, err)
			}
		})
	}
}

func TestCoreSelectorSupportsGRPCMultiModeAndAuthority(t *testing.T) {
	profile := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=grpc&security=tls"+
			"&serviceName=Tunnel&mode=multi&authority=grpc.example")
	if profile.Mode != "multi" || profile.Authority != "grpc.example" {
		t.Fatalf("gRPC mode or authority was not parsed: %s", profile)
	}
	core, err := (CoreSelector{}).Select(profile)
	if err != nil || core != CoreXray {
		t.Fatalf("expected Xray selection for gRPC multi mode, got %q, %v", core, err)
	}
}

func TestGRPCHostAndAuthorityAreScopedAndValidated(t *testing.T) {
	hostOnly := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=grpc&host=grpc.example")
	if hostOnly.Host != "grpc.example" || hostOnly.Authority != "grpc.example" {
		t.Fatalf("gRPC host should be retained and used as default authority: %#v", hostOnly)
	}

	explicitAuthority := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=grpc&host=grpc.example"+
			"&authority=grpc.example")
	if explicitAuthority.Host != "grpc.example" || explicitAuthority.Authority != "grpc.example" {
		t.Fatalf("matching gRPC host and authority were not retained: %#v", explicitAuthority)
	}

	for _, uri := range []string{
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&host=one.example&authority=two.example",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&authority=grpc.example",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&authority=grpc.example",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&authority=grpc.example%2Fpath",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&authority=grpc.example%3A70000",
	} {
		_, err := ParseVLESSProfile(profileServer(uri))
		if !errors.Is(err, ErrUnsupportedVLESSProfile) {
			if !errors.Is(err, ErrInvalidVLESSProfile) {
				t.Fatalf("expected transport-scoped or malformed authority rejection, got %v", err)
			}
		}
	}

	xhttp := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=xhttp&host=xhttp.example&path=%2Fconnect")
	if xhttp.Host != "xhttp.example" || xhttp.Path != "/connect" {
		t.Fatalf("XHTTP host/path semantics changed: %#v", xhttp)
	}
}

func TestCoreSelectorSupportsVisionUDP443OnlyForXrayWithTLSOrReality(t *testing.T) {
	for _, securityParams := range []string{
		"security=tls",
		"security=reality&pbk=" + syntheticRealityKey + "&sid=abcd",
	} {
		t.Run(securityParams, func(t *testing.T) {
			profile := mustParseVLESSProfile(t,
				"vless://"+syntheticVLESSUUID+"@example.com:443?type=tcp&"+securityParams+
					"&flow=xtls-rprx-vision-udp443&fp=chrome")
			core, err := (CoreSelector{}).Select(profile)
			if err != nil || core != CoreXray {
				t.Fatalf("expected Xray for Vision UDP/443 with %s, got %q, %v", securityParams, core, err)
			}
		})
	}

	for _, uri := range []string{
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&flow=xtls-rprx-vision-udp443",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&security=tls&flow=xtls-rprx-vision-udp443",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&security=tls&flow=xtls-rprx-vision-udp443",
	} {
		profile, err := ParseVLESSProfile(profileServer(uri))
		if err == nil {
			_, err = (CoreSelector{}).Select(profile)
		}
		if !errors.Is(err, ErrUnsupportedVLESSProfile) {
			t.Fatalf("expected invalid Vision UDP/443 combination rejection, got %v", err)
		}
	}
}

func TestVLESSProfileValidatesRealityTLSAndFlowCombinations(t *testing.T) {
	valid := []struct {
		name string
		uri  string
		core CoreKind
	}{
		{
			name: "tcp vision reality",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=reality" +
				"&flow=xtls-rprx-vision&pbk=" + syntheticRealityKey + "&sid=abcd",
			core: CoreSingBox,
		},
		{
			name: "tcp vision tls",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=tls&flow=xtls-rprx-vision",
			core: CoreXray,
		},
		{
			name: "xhttp reality no flow",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&security=reality" +
				"&pbk=" + syntheticRealityKey + "&sid=abcd&fp=chrome&mode=packet-up",
			core: CoreXray,
		},
	}
	for _, test := range valid {
		t.Run(test.name, func(t *testing.T) {
			profile := mustParseVLESSProfile(t, test.uri)
			core, err := (CoreSelector{}).Select(profile)
			if err != nil || core != test.core {
				t.Fatalf("unexpected selection %q, %v", core, err)
			}
		})
	}

	invalid := []string{
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=none&flow=xtls-rprx-vision",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&security=tls&flow=xtls-rprx-vision",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&security=reality&mode=stream-one&pbk=" +
			syntheticRealityKey + "&sid=abcd",
		"vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=reality&sid=abcd",
	}
	for _, uri := range invalid {
		profile, err := ParseVLESSProfile(profileServer(uri))
		if err == nil {
			_, err = (CoreSelector{}).Select(profile)
		}
		if err == nil {
			t.Fatalf("expected invalid security/flow combination to fail")
		}
	}

	profile := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=xhttp&security=reality"+
			"&pbk="+syntheticRealityKey+"&sid=abcd")
	if _, err := (CoreSelector{}).Select(profile); !errors.Is(err, ErrUnsupportedVLESSProfile) {
		t.Fatalf("Xray Reality without its required fingerprint should be rejected, got %v", err)
	}

	profile = mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=tcp&security=reality"+
			"&flow=xtls-rprx-vision-udp443&pbk="+syntheticRealityKey+"&sid=abcd")
	if _, err := (CoreSelector{}).Select(profile); !errors.Is(err, ErrUnsupportedVLESSProfile) {
		t.Fatalf("Xray Reality without fingerprint should be rejected, got %v", err)
	}
}

func TestVLESSProfileRejectsInvalidRealitySpiderXPath(t *testing.T) {
	for _, value := range []string{"probe", "https://example.com/probe", "relative/path"} {
		uri := "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&security=reality&pbk=" +
			syntheticRealityKey + "&sid=abcd&spiderX=" + value
		_, err := ParseVLESSProfile(profileServer(uri))
		if !errors.Is(err, ErrInvalidVLESSProfile) {
			t.Fatalf("expected invalid spiderX rejection without echo, got %v", err)
		}
		if strings.Contains(err.Error(), value) {
			t.Fatalf("error exposed spiderX value: %v", err)
		}
	}
}

func TestVLESSProfilePreservesRepeatedAndCommaSeparatedALPN(t *testing.T) {
	profile := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?security=tls"+
			"&alpn=h2&alpn=http%2F1.1&alpn=h3%2Ch2")
	want := []string{"h2", "http/1.1", "h3", "h2"}
	if len(profile.ALPN) != len(want) {
		t.Fatalf("expected repeated ALPN values %v, got %v", want, profile.ALPN)
	}
	for index := range want {
		if profile.ALPN[index] != want[index] {
			t.Fatalf("expected ALPN values %v, got %v", want, profile.ALPN)
		}
	}
	if _, err := ParseVLESSProfile(profileServer(
		"vless://" + syntheticVLESSUUID + "@example.com:443?security=tls&alpn=h2&alpn=",
	)); !errors.Is(err, ErrInvalidVLESSProfile) {
		t.Fatalf("expected empty repeated ALPN value rejection, got %v", err)
	}
}

func TestCoreSelectorRejectsUnsupportedCombinationsWithoutFallback(t *testing.T) {
	tests := []struct {
		name string
		uri  string
	}{
		{
			name: "vision with xhttp",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&security=reality" +
				"&flow=xtls-rprx-vision&pbk=" + syntheticRealityKey + "&sid=abcd",
		},
		{
			name: "mode on tcp",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&mode=stream-one",
		},
		{
			name: "path on grpc",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=grpc&path=%2Fsecret",
		},
		{
			name: "unsupported mode",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&mode=secret-token",
		},
		{
			name: "grpc mode on xhttp",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=xhttp&mode=multi",
		},
		{
			name: "unsupported transport",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=ws",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile, err := ParseVLESSProfile(profileServer(test.uri))
			if err == nil {
				_, err = (CoreSelector{}).Select(profile)
			}
			if !errors.Is(err, ErrUnsupportedVLESSProfile) {
				t.Fatalf("expected unsupported-combination error, got %v", err)
			}
			if strings.Contains(err.Error(), "secret-token") || strings.Contains(err.Error(), "secret") {
				t.Fatalf("error exposed an input value: %v", err)
			}
		})
	}
}

func TestParseVLESSProfileRejectsMalformedAndAmbiguousURIsWithoutEchoingSecrets(t *testing.T) {
	tests := []struct {
		name string
		uri  string
		want error
	}{
		{
			name: "malformed escape",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?path=%zzsecret",
			want: ErrInvalidVLESSProfile,
		},
		{
			name: "repeated transport",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp&type=xhttp",
			want: ErrInvalidVLESSProfile,
		},
		{
			name: "invalid uuid",
			uri:  "vless://synthetic-secret@example.com:443?type=tcp",
			want: ErrInvalidVLESSProfile,
		},
		{
			name: "unknown secret parameter",
			uri:  "vless://" + syntheticVLESSUUID + "@example.com:443?synthetic-secret=secret-value",
			want: ErrUnsupportedVLESSParameter,
		},
		{
			name: "invalid reality key",
			uri: "vless://" + syntheticVLESSUUID + "@example.com:443?security=reality&pbk=synthetic-secret" +
				"&sid=secret-value",
			want: ErrInvalidVLESSProfile,
		},
		{
			name: "password in user info",
			uri:  "vless://" + syntheticVLESSUUID + ":synthetic-secret@example.com:443?type=tcp",
			want: ErrInvalidVLESSProfile,
		},
		{
			name: "address mismatch",
			uri:  "vless://" + syntheticVLESSUUID + "@other.example:443?password=secret-value",
			want: ErrInvalidVLESSProfile,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseVLESSProfile(profileServer(test.uri))
			if !errors.Is(err, test.want) {
				t.Fatalf("expected %v, got %v", test.want, err)
			}
			if strings.Contains(err.Error(), "synthetic-secret") || strings.Contains(err.Error(), "secret-value") {
				t.Fatalf("parser error exposed input data: %v", err)
			}
		})
	}
}

func TestVLESSProfileFormattingDoesNotExposeProfileSecrets(t *testing.T) {
	secretUUID := "123e4567-e89b-12d3-a456-426614174099"
	secretKey := "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	profile := mustParseVLESSProfile(t,
		"vless://"+secretUUID+"@example.com:443?type=xhttp&security=reality&mode=stream-one"+
			"&host=synthetic-host-secret&path=%2Fsynthetic-path-secret"+
			"&sni=synthetic-sni-secret&pbk="+secretKey+"&sid=deadbeef")
	formatted := fmt.Sprintf("%v %+v %#v", profile, profile, profile)
	for _, secret := range []string{
		secretUUID, secretKey, "synthetic-host-secret", "synthetic-path-secret",
		"synthetic-sni-secret", "deadbeef",
	} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("formatted profile exposed %q: %s", secret, formatted)
		}
	}
}

func TestVLESSProfileIgnoresURIFragmentWithoutExposingIt(t *testing.T) {
	profile := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=tcp#synthetic-fragment-secret")
	formatted := fmt.Sprintf("%v %+v %#v", profile, profile, profile)
	if strings.Contains(formatted, "synthetic-fragment-secret") {
		t.Fatalf("profile formatting exposed the URI fragment: %s", formatted)
	}
}

func TestVLESSProfileJSONSerializationIsRejected(t *testing.T) {
	profile := mustParseVLESSProfile(t,
		"vless://"+syntheticVLESSUUID+"@example.com:443?type=xhttp&security=reality"+
			"&pbk="+syntheticRealityKey+"&sid=deadbeef&host=synthetic-host-secret")
	encoded, err := json.Marshal(profile)
	if !errors.Is(err, ErrVLESSProfileSerialization) {
		t.Fatalf("expected direct profile JSON serialization to fail, got %v", err)
	}
	if strings.Contains(string(encoded), syntheticVLESSUUID) ||
		strings.Contains(string(encoded), syntheticRealityKey) ||
		strings.Contains(string(encoded), "deadbeef") ||
		strings.Contains(string(encoded), "synthetic-host-secret") {
		t.Fatalf("serialized profile exposed secrets: %s", encoded)
	}
	if strings.Contains(profile.String(), syntheticVLESSUUID) ||
		strings.Contains(profile.String(), syntheticRealityKey) ||
		strings.Contains(profile.String(), "deadbeef") ||
		strings.Contains(profile.String(), "synthetic-host-secret") {
		t.Fatalf("profile diagnostic formatting exposed secrets: %s", profile.String())
	}
}

func TestExistingGeneratorDoesNotEchoQuerySecretsInErrors(t *testing.T) {
	server := profileServer("vless://" + syntheticVLESSUUID + "@example.com:443?security=synthetic-secret")
	_, _, err := GenerateRuntimeConfig(server)
	if err == nil || strings.Contains(err.Error(), "synthetic-secret") {
		t.Fatalf("generator error was missing or exposed query data: %v", err)
	}

	server.URI = "vless://" + syntheticVLESSUUID + "@example.com:443?synthetic-secret=secret-value"
	_, _, err = GenerateRuntimeConfig(server)
	if err == nil || strings.Contains(err.Error(), "synthetic-secret") || strings.Contains(err.Error(), "secret-value") {
		t.Fatalf("generator error was missing or exposed query data: %v", err)
	}

	server.Protocol = "synthetic-protocol-secret"
	server.URI = "vless://" + syntheticVLESSUUID + "@example.com:443?type=tcp"
	_, _, err = GenerateRuntimeConfig(server)
	if err == nil || strings.Contains(err.Error(), "synthetic-protocol-secret") {
		t.Fatalf("generator error exposed an untrusted protocol field: %v", err)
	}
}
