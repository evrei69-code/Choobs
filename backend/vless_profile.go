package main

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

type VLESSTransport string

const (
	VLESSTransportTCP   VLESSTransport = "tcp"
	VLESSTransportXHTTP VLESSTransport = "xhttp"
	VLESSTransportGRPC  VLESSTransport = "grpc"
)

type VLESSSecurity string

const (
	VLESSSecurityNone    VLESSSecurity = "none"
	VLESSSecurityTLS     VLESSSecurity = "tls"
	VLESSSecurityReality VLESSSecurity = "reality"
)

type CoreKind string

const (
	CoreSingBox CoreKind = "sing-box"
	CoreXray    CoreKind = "xray"
)

const (
	VLESSFlowVision       = "xtls-rprx-vision"
	VLESSFlowVisionUDP443 = "xtls-rprx-vision-udp443"
)

var (
	ErrInvalidVLESSProfile       = errors.New("VLESS profile is invalid")
	ErrUnsupportedVLESSParameter = errors.New("VLESS URI contains an unsupported parameter")
	ErrUnsupportedVLESSProfile   = errors.New("VLESS profile combination is not supported by available cores")
	ErrVLESSProfileSerialization = errors.New("VLESS profile serialization is not supported")
)

type VLESSProfile struct {
	ServerAddress string
	ServerPort    uint16
	UUID          string
	Encryption    string
	Transport     VLESSTransport
	Security      VLESSSecurity
	Flow          string
	Mode          string
	Host          string
	Authority     string
	Path          string
	ServiceName   string
	SpiderX       string
	ServerName    string
	Fingerprint   string
	PublicKey     string
	ShortID       string
	ALPN          []string
	HeaderType    string
}

func (profile VLESSProfile) String() string {
	flow := "absent"
	if profile.Flow != "" {
		flow = "present"
	}
	mode := safeProfileMode(profile.Mode)
	return fmt.Sprintf(
		"VLESSProfile{transport:%s, security:%s, flow:%s, mode:%s}",
		safeProfileTransport(profile.Transport),
		safeProfileSecurity(profile.Security),
		flow,
		mode,
	)
}

func (profile VLESSProfile) GoString() string {
	return profile.String()
}

// MarshalJSON blocks accidental serialization of credentials and server identifiers.
func (VLESSProfile) MarshalJSON() ([]byte, error) {
	return nil, ErrVLESSProfileSerialization
}

func ParseVLESSProfile(server ServerInput) (VLESSProfile, error) {
	if !strings.EqualFold(server.Protocol, "VLESS") || len(server.URI) == 0 || len(server.URI) > 8192 ||
		!validHost(server.Address) || server.Port < 1 || server.Port > 65535 {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}

	parsed, err := url.Parse(server.URI)
	if err != nil || !strings.EqualFold(parsed.Scheme, "vless") || parsed.Opaque != "" ||
		parsed.User == nil || parsed.Path != "" || parsed.Hostname() == "" {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}
	if _, hasPassword := parsed.User.Password(); hasPassword {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}

	uuid := parsed.User.Username()
	if !validUUID(uuid) || !strings.EqualFold(parsed.Hostname(), server.Address) {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}
	port := server.Port
	if parsed.Port() != "" {
		port, err = strconv.Atoi(parsed.Port())
	}
	if err != nil || port != server.Port {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}

	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}
	values := make(map[string]string, len(query))
	var alpnValues []string
	for name, entries := range query {
		canonicalName, ok := canonicalVLESSParameter(name)
		if !ok {
			return VLESSProfile{}, ErrUnsupportedVLESSParameter
		}
		if canonicalName == "alpn" {
			if len(entries) == 0 {
				return VLESSProfile{}, ErrInvalidVLESSProfile
			}
			for _, entry := range entries {
				if entry == "" || !validVLESSParameterValue(entry) {
					return VLESSProfile{}, ErrInvalidVLESSProfile
				}
				alpnValues = append(alpnValues, entry)
			}
			continue
		}
		if len(entries) != 1 || !validVLESSParameterValue(entries[0]) {
			return VLESSProfile{}, ErrInvalidVLESSProfile
		}
		if previous, exists := values[canonicalName]; exists {
			if !isVLESSParameterAlias(canonicalName) || previous != entries[0] {
				return VLESSProfile{}, ErrInvalidVLESSProfile
			}
			continue
		}
		values[canonicalName] = entries[0]
	}

	profile := VLESSProfile{
		ServerAddress: server.Address,
		ServerPort:    uint16(server.Port),
		UUID:          uuid,
		Encryption:    strings.ToLower(values["encryption"]),
		Transport:     VLESSTransport(strings.ToLower(values["type"])),
		Security:      VLESSSecurity(strings.ToLower(values["security"])),
		Flow:          strings.ToLower(values["flow"]),
		Mode:          strings.ToLower(values["mode"]),
		Host:          values["host"],
		Authority:     values["authority"],
		Path:          values["path"],
		ServiceName:   values["servicename"],
		SpiderX:       values["spiderx"],
		ServerName:    values["servername"],
		Fingerprint:   strings.ToLower(values["fingerprint"]),
		PublicKey:     values["publickey"],
		ShortID:       values["shortid"],
		HeaderType:    strings.ToLower(values["headertype"]),
	}
	if profile.Encryption == "" {
		profile.Encryption = "none"
	}
	if profile.Transport == "" {
		profile.Transport = VLESSTransportTCP
	}
	if profile.Security == "" {
		profile.Security = VLESSSecurityNone
	}
	if profile.HeaderType != "" && profile.HeaderType != "none" {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.Encryption != "none" {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.Transport != VLESSTransportTCP && profile.Transport != VLESSTransportXHTTP &&
		profile.Transport != VLESSTransportGRPC {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.Security != VLESSSecurityNone && profile.Security != VLESSSecurityTLS &&
		profile.Security != VLESSSecurityReality {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.Flow != "" && profile.Flow != VLESSFlowVision &&
		profile.Flow != VLESSFlowVisionUDP443 {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if !validModeForTransport(profile.Transport, profile.Mode) {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}

	profile.ALPN, err = parseVLESSALPN(alpnValues)
	if err != nil {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}
	if profile.Transport == VLESSTransportGRPC {
		if profile.Authority != "" && profile.Host != "" && profile.Authority != profile.Host {
			return VLESSProfile{}, ErrUnsupportedVLESSProfile
		}
		if profile.Authority == "" {
			profile.Authority = profile.Host
		}
		if profile.Authority != "" && !validVLESSAuthority(profile.Authority) {
			return VLESSProfile{}, ErrInvalidVLESSProfile
		}
	} else if profile.Authority != "" {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.ServerName == "" {
		profile.ServerName = parsed.Hostname()
	}
	if profile.Security == VLESSSecurityReality {
		if !validBase64URL(profile.PublicKey) || !validHex(profile.ShortID) {
			return VLESSProfile{}, ErrInvalidVLESSProfile
		}
	} else if profile.PublicKey != "" || profile.ShortID != "" || profile.SpiderX != "" {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.SpiderX != "" && !strings.HasPrefix(profile.SpiderX, "/") {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}
	if profile.Security == VLESSSecurityNone {
		if values["servername"] != "" || profile.Fingerprint != "" || len(profile.ALPN) != 0 {
			return VLESSProfile{}, ErrUnsupportedVLESSProfile
		}
	} else if !validHost(profile.ServerName) {
		return VLESSProfile{}, ErrInvalidVLESSProfile
	}
	if profile.Fingerprint != "" && !validFingerprint(profile.Fingerprint) {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}
	if profile.Flow != "" && profile.Security == VLESSSecurityNone {
		return VLESSProfile{}, ErrUnsupportedVLESSProfile
	}

	return profile, nil
}

type CoreSelector struct{}

func (CoreSelector) Select(profile VLESSProfile) (CoreKind, error) {
	if !validSelectableProfile(profile) {
		return "", ErrUnsupportedVLESSProfile
	}

	switch profile.Transport {
	case VLESSTransportXHTTP:
		if profile.Flow != "" || profile.ServiceName != "" || profile.Authority != "" ||
			!validModeForTransport(profile.Transport, profile.Mode) {
			return "", ErrUnsupportedVLESSProfile
		}
		if profile.SpiderX != "" && profile.Security != VLESSSecurityReality {
			return "", ErrUnsupportedVLESSProfile
		}
		if !xrayRealitySupported(profile) {
			return "", ErrUnsupportedVLESSProfile
		}
		return selectXrayProfile(profile)

	case VLESSTransportGRPC:
		if profile.Flow != "" || profile.Path != "" ||
			!validModeForTransport(profile.Transport, profile.Mode) {
			return "", ErrUnsupportedVLESSProfile
		}
		if profile.SpiderX != "" && profile.Security != VLESSSecurityReality {
			return "", ErrUnsupportedVLESSProfile
		}
		if !xrayRealitySupported(profile) {
			return "", ErrUnsupportedVLESSProfile
		}
		return selectXrayProfile(profile)

	case VLESSTransportTCP:
		if profile.Mode != "" || profile.Host != "" || profile.Authority != "" ||
			profile.Path != "" || profile.ServiceName != "" {
			return "", ErrUnsupportedVLESSProfile
		}
		if profile.SpiderX != "" && profile.Security != VLESSSecurityReality {
			return "", ErrUnsupportedVLESSProfile
		}
		if profile.Flow == "" || (profile.Flow == VLESSFlowVision && profile.Security == VLESSSecurityReality) {
			if profile.SpiderX == "" {
				return CoreSingBox, nil
			}
			if !xrayRealitySupported(profile) {
				return "", ErrUnsupportedVLESSProfile
			}
			return selectXrayProfile(profile)
		}
		if isVLESSVisionFlow(profile.Flow) &&
			(profile.Security == VLESSSecurityTLS || profile.Security == VLESSSecurityReality) {
			if !xrayRealitySupported(profile) {
				return "", ErrUnsupportedVLESSProfile
			}
			return selectXrayProfile(profile)
		}
	}

	return "", ErrUnsupportedVLESSProfile
}

func selectXrayProfile(profile VLESSProfile) (CoreKind, error) {
	if err := validateXrayProfile(profile); err != nil {
		return "", ErrUnsupportedVLESSProfile
	}
	return CoreXray, nil
}

func validSelectableProfile(profile VLESSProfile) bool {
	if profile.Encryption != "none" || profile.HeaderType != "" && profile.HeaderType != "none" {
		return false
	}
	if profile.Security != VLESSSecurityNone && profile.Security != VLESSSecurityTLS &&
		profile.Security != VLESSSecurityReality {
		return false
	}
	if profile.Flow != "" && !isVLESSVisionFlow(profile.Flow) {
		return false
	}
	if !validModeForTransport(profile.Transport, profile.Mode) {
		return false
	}
	if profile.Security == VLESSSecurityReality {
		if !validBase64URL(profile.PublicKey) || !validHex(profile.ShortID) {
			return false
		}
	} else if profile.PublicKey != "" || profile.ShortID != "" || profile.SpiderX != "" {
		return false
	}
	if profile.SpiderX != "" && !strings.HasPrefix(profile.SpiderX, "/") {
		return false
	}
	if profile.Security == VLESSSecurityNone {
		if profile.Fingerprint != "" || len(profile.ALPN) != 0 {
			return false
		}
	} else if !validHost(profile.ServerName) {
		return false
	}
	if profile.Fingerprint != "" && !validFingerprint(profile.Fingerprint) {
		return false
	}
	if profile.Transport != VLESSTransportGRPC && profile.Authority != "" {
		return false
	}
	if profile.Transport == VLESSTransportGRPC && profile.Host != "" &&
		profile.Authority != "" && profile.Host != profile.Authority {
		return false
	}
	if profile.Authority != "" && !validVLESSAuthority(profile.Authority) {
		return false
	}
	for _, protocol := range profile.ALPN {
		if !validVLESSParameterValue(protocol) {
			return false
		}
	}
	return true
}

func canonicalVLESSParameter(name string) (string, bool) {
	switch strings.ToLower(name) {
	case "encryption":
		return "encryption", true
	case "type":
		return "type", true
	case "security":
		return "security", true
	case "flow":
		return "flow", true
	case "mode":
		return "mode", true
	case "authority":
		return "authority", true
	case "host":
		return "host", true
	case "path":
		return "path", true
	case "servicename":
		return "servicename", true
	case "spiderx", "spx":
		return "spiderx", true
	case "sni", "servername":
		return "servername", true
	case "fp", "fingerprint":
		return "fingerprint", true
	case "pbk", "publickey":
		return "publickey", true
	case "sid", "shortid":
		return "shortid", true
	case "headertype":
		return "headertype", true
	case "alpn":
		return "alpn", true
	default:
		return "", false
	}
}

func isVLESSParameterAlias(name string) bool {
	switch name {
	case "servername", "fingerprint", "publickey", "shortid", "spiderx":
		return true
	default:
		return false
	}
}

func validModeForTransport(transport VLESSTransport, mode string) bool {
	if mode == "" {
		return true
	}
	switch transport {
	case VLESSTransportXHTTP:
		return mode == "auto" || mode == "packet-up" || mode == "stream-up" || mode == "stream-one"
	case VLESSTransportGRPC:
		return mode == "multi"
	default:
		return false
	}
}

func isVLESSVisionFlow(flow string) bool {
	return flow == VLESSFlowVision || flow == VLESSFlowVisionUDP443
}

func validVLESSAuthority(value string) bool {
	parsed, err := url.Parse("//" + value)
	if err != nil || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" || !validHost(parsed.Hostname()) {
		return false
	}
	if parsed.Port() == "" {
		return true
	}
	port, err := strconv.Atoi(parsed.Port())
	return err == nil && port > 0 && port <= 65535
}

func xrayRealitySupported(profile VLESSProfile) bool {
	return profile.Security != VLESSSecurityReality || profile.Fingerprint != ""
}

func validVLESSParameterValue(value string) bool {
	if len(value) > 4096 {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

func parseVLESSALPN(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			part = strings.TrimSpace(part)
			if part == "" || len(part) > 255 || !validVLESSParameterValue(part) {
				return nil, ErrInvalidVLESSProfile
			}
			result = append(result, part)
		}
	}
	return result, nil
}

func safeProfileTransport(transport VLESSTransport) string {
	switch transport {
	case VLESSTransportTCP, VLESSTransportXHTTP, VLESSTransportGRPC:
		return string(transport)
	default:
		return "unknown"
	}
}

func safeProfileSecurity(security VLESSSecurity) string {
	switch security {
	case VLESSSecurityNone, VLESSSecurityTLS, VLESSSecurityReality:
		return string(security)
	default:
		return "unknown"
	}
}

func safeProfileMode(mode string) string {
	switch mode {
	case "", "auto", "packet-up", "stream-up", "stream-one", "multi":
		if mode == "" {
			return "absent"
		}
		return mode
	default:
		return "unknown"
	}
}
