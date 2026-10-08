package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

type ServerInput struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Port     int    `json:"port"`
	URI      string `json:"uri"`
}

type runtimeConfig struct {
	Log       runtimeLog       `json:"log"`
	Inbounds  []map[string]any `json:"inbounds"`
	Outbounds []map[string]any `json:"outbounds"`
	Route     runtimeRoute     `json:"route"`
}

type runtimeLog struct {
	Disabled bool `json:"disabled"`
}

type runtimeRoute struct {
	Final string `json:"final"`
}

func GenerateRuntimeConfig(server ServerInput, listenPorts ...uint16) ([]byte, []string, error) {
	if server.Protocol != "VLESS" {
		return nil, nil, fmt.Errorf("%s configuration is not implemented yet; only VLESS is supported", server.Protocol)
	}
	if strings.TrimSpace(server.Address) == "" || server.Port < 1 || server.Port > 65535 {
		return nil, nil, fmt.Errorf("server address or port is invalid")
	}
	if len(server.URI) == 0 || len(server.URI) > 8192 {
		return nil, nil, fmt.Errorf("VLESS URI is invalid")
	}
	if len(listenPorts) > 1 {
		return nil, nil, fmt.Errorf("only one local proxy port can be configured")
	}
	listenPort := uint16(2080)
	if len(listenPorts) == 1 {
		listenPort = listenPorts[0]
	}
	if listenPort == 0 {
		return nil, nil, fmt.Errorf("local proxy port is invalid")
	}

	parsed, err := url.Parse(server.URI)
	if err != nil || strings.ToLower(parsed.Scheme) != "vless" || parsed.User == nil {
		return nil, nil, fmt.Errorf("server does not contain a valid VLESS URI")
	}
	if _, hasPassword := parsed.User.Password(); hasPassword {
		return nil, nil, fmt.Errorf("server does not contain a valid VLESS URI")
	}
	uuid := parsed.User.Username()
	if !validUUID(uuid) {
		return nil, nil, fmt.Errorf("VLESS URI does not contain a valid UUID")
	}
	uriPort := server.Port
	if parsed.Port() != "" {
		uriPort, err = strconv.Atoi(parsed.Port())
	}
	if err != nil || !validHost(server.Address) || parsed.Hostname() == "" ||
		!strings.EqualFold(parsed.Hostname(), server.Address) || uriPort != server.Port {
		return nil, nil, fmt.Errorf("VLESS URI address does not match the selected server")
	}

	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return nil, nil, fmt.Errorf("VLESS query parameters are malformed")
	}
	supportedParameters := map[string]bool{
		"encryption":  true,
		"flow":        true,
		"security":    true,
		"sni":         true,
		"serverName":  true,
		"type":        true,
		"headerType":  true,
		"host":        true,
		"path":        true,
		"serviceName": true,
		"pbk":         true,
		"sid":         true,
		"publicKey":   true,
		"shortId":     true,
		"spiderX":     true,
		"fp":          true,
		"alpn":        true,
	}
	for key := range query {
		if !supportedParameters[key] {
			return nil, nil, fmt.Errorf("Unsupported VLESS parameter: %s", key)
		}
	}
	for _, key := range []string{"encryption", "flow", "security", "sni", "serverName", "type", "headerType", "host", "path", "serviceName", "pbk", "sid", "publicKey", "shortId", "spiderX", "fp"} {
		if len(query[key]) > 1 {
			return nil, nil, fmt.Errorf("VLESS parameter %q is repeated", key)
		}
	}
	publicKey, err := aliasedQueryValue(query, "pbk", "publicKey")
	if err != nil {
		return nil, nil, err
	}
	shortID, err := aliasedQueryValue(query, "sid", "shortId")
	if err != nil {
		return nil, nil, err
	}
	if value := query.Get("encryption"); value != "" && value != "none" {
		return nil, nil, fmt.Errorf("VLESS encryption %q is not supported", value)
	}
	network := query.Get("type")
	if network != "" && network != "tcp" {
		return nil, nil, fmt.Errorf("VLESS transport %q is not implemented yet", network)
	}
	if headerType := query.Get("headerType"); headerType != "" && headerType != "none" {
		return nil, nil, fmt.Errorf("VLESS header type %q is not implemented yet", headerType)
	}
	for _, unsupported := range []string{"host", "path", "serviceName", "spiderX"} {
		if query.Get(unsupported) != "" {
			return nil, nil, fmt.Errorf("VLESS parameter %q is not implemented yet", unsupported)
		}
	}

	security := query.Get("security")
	if security != "" && security != "none" && security != "tls" && security != "reality" {
		return nil, nil, fmt.Errorf("VLESS security mode %q is not implemented yet", security)
	}
	serverName := query.Get("sni")
	if query.Get("serverName") != "" {
		if serverName != "" && serverName != query.Get("serverName") {
			return nil, nil, fmt.Errorf("VLESS SNI parameters do not match")
		}
		serverName = query.Get("serverName")
	}
	if serverName == "" {
		serverName = parsed.Hostname()
	}

	flow := query.Get("flow")
	if flow != "" && flow != "xtls-rprx-vision" {
		return nil, nil, fmt.Errorf("VLESS flow %q is not supported", flow)
	}
	if flow != "" && security != "reality" {
		return nil, nil, fmt.Errorf("VLESS flow requires Reality security")
	}
	if security == "reality" {
		if publicKey == "" {
			return nil, nil, fmt.Errorf("VLESS Reality requires pbk or publicKey")
		}
		if !validBase64URL(publicKey) || !validHex(shortID) {
			return nil, nil, fmt.Errorf("VLESS Reality publicKey or shortId is invalid")
		}
	} else if publicKey != "" || shortID != "" {
		return nil, nil, fmt.Errorf("VLESS publicKey and shortId require Reality security")
	}
	if security != "none" && !validHost(strings.TrimSpace(serverName)) {
		return nil, nil, fmt.Errorf("VLESS TLS server name is invalid")
	}

	vlessOutbound := map[string]any{
		"type":        "vless",
		"tag":         "proxy",
		"server":      server.Address,
		"server_port": server.Port,
		"uuid":        uuid,
		"network":     "tcp",
	}
	if flow != "" {
		vlessOutbound["flow"] = flow
	}
	if security == "tls" || security == "reality" {
		tls := map[string]any{
			"enabled":     true,
			"server_name": serverName,
		}
		if rawALPNValues := query["alpn"]; len(rawALPNValues) > 0 {
			var alpn []string
			for _, rawALPN := range rawALPNValues {
				for _, protocol := range strings.Split(rawALPN, ",") {
					protocol = strings.TrimSpace(protocol)
					if protocol == "" {
						return nil, nil, fmt.Errorf("VLESS ALPN value is invalid")
					}
					alpn = append(alpn, protocol)
				}
			}
			tls["alpn"] = alpn
		}
		if fingerprint := query.Get("fp"); fingerprint != "" {
			if !validFingerprint(fingerprint) {
				return nil, nil, fmt.Errorf("VLESS TLS fingerprint is unsupported")
			}
			tls["utls"] = map[string]any{"enabled": true, "fingerprint": fingerprint}
		}
		if security == "reality" {
			tls["reality"] = map[string]any{
				"enabled":    true,
				"public_key": publicKey,
				"short_id":   shortID,
			}
		}
		vlessOutbound["tls"] = tls
	} else if query.Get("sni") != "" || query.Get("serverName") != "" || query.Get("fp") != "" || query.Get("alpn") != "" {
		return nil, nil, fmt.Errorf("VLESS TLS parameters require TLS or Reality security")
	}

	config := runtimeConfig{
		Log: runtimeLog{Disabled: true},
		Inbounds: []map[string]any{{
			"type":        "mixed",
			"tag":         "local-proxy",
			"listen":      "127.0.0.1",
			"listen_port": listenPort,
		}},
		Outbounds: []map[string]any{vlessOutbound, {"type": "direct", "tag": "direct"}},
		Route:     runtimeRoute{Final: "proxy"},
	}
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("could not encode runtime config")
	}
	secrets := []string{uuid, server.URI, url.QueryEscape(server.URI)}
	for _, values := range query {
		for _, value := range values {
			if value != "" {
				secrets = append(secrets, value)
				secrets = append(secrets, url.QueryEscape(value))
			}
		}
	}
	return append(encoded, '\n'), uniqueStrings(secrets), nil
}

func aliasedQueryValue(query url.Values, standardName, legacyName string) (string, error) {
	standardValue := query.Get(standardName)
	legacyValue := query.Get(legacyName)
	if standardValue != "" && legacyValue != "" && standardValue != legacyValue {
		return "", fmt.Errorf("VLESS parameters %q and %q conflict", standardName, legacyName)
	}
	if standardValue != "" {
		return standardValue, nil
	}
	return legacyValue, nil
}

func validUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		switch index {
		case 8, 13, 18, 23:
			if character != '-' {
				return false
			}
		default:
			if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
				return false
			}
		}
	}
	return true
}

func validHost(value string) bool {
	if net.ParseIP(value) != nil {
		return true
	}
	if len(value) == 0 || len(value) > 253 || strings.HasSuffix(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
				(character >= '0' && character <= '9') || character == '-') {
				return false
			}
		}
	}
	return true
}

func validBase64URL(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
	return err == nil && len(decoded) == 32
}

func validHex(value string) bool {
	if len(value) > 16 || len(value)%2 != 0 {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func validFingerprint(value string) bool {
	switch value {
	case "chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized":
		return true
	default:
		return false
	}
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}
