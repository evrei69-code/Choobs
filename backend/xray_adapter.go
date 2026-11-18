package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

var (
	ErrXrayConfigInvalid     = errors.New("Xray configuration parameters are invalid")
	ErrXrayConfigUnsupported = errors.New("Xray configuration combination is not supported")
)

type XrayAdapter struct{}

type xrayRuntimeConfig struct {
	Log       xrayLogConfig     `json:"log"`
	Inbounds  []xrayInbound     `json:"inbounds"`
	Outbounds []xrayOutbound    `json:"outbounds"`
	Routing   xrayRoutingConfig `json:"routing"`
}

type xrayLogConfig struct {
	Access   string `json:"access"`
	Error    string `json:"error"`
	LogLevel string `json:"loglevel"`
}

type xrayInbound struct {
	Listen   string         `json:"listen"`
	Port     uint16         `json:"port"`
	Protocol string         `json:"protocol"`
	Settings map[string]any `json:"settings"`
	Tag      string         `json:"tag"`
}

type xrayOutbound struct {
	Protocol      string              `json:"protocol"`
	Tag           string              `json:"tag"`
	Settings      any                 `json:"settings"`
	StreamSetting *xrayStreamSettings `json:"streamSettings,omitempty"`
}

type xrayVLESSSettings struct {
	VNext []xrayVLESSVNext `json:"vnext"`
}

type xrayVLESSVNext struct {
	Address string          `json:"address"`
	Port    uint16          `json:"port"`
	Users   []xrayVLESSUser `json:"users"`
}

type xrayVLESSUser struct {
	ID         string `json:"id"`
	Encryption string `json:"encryption"`
	Flow       string `json:"flow,omitempty"`
}

type xrayStreamSettings struct {
	Network         string               `json:"network"`
	Security        string               `json:"security"`
	TLSSettings     *xrayTLSSettings     `json:"tlsSettings,omitempty"`
	RealitySettings *xrayRealitySettings `json:"realitySettings,omitempty"`
	XHTTPSettings   *xrayXHTTPSettings   `json:"xhttpSettings,omitempty"`
	GRPCSettings    *xrayGRPCSettings    `json:"grpcSettings,omitempty"`
}

type xrayTLSSettings struct {
	ServerName  string   `json:"serverName"`
	Fingerprint string   `json:"fingerprint,omitempty"`
	ALPN        []string `json:"alpn,omitempty"`
	MinVersion  string   `json:"minVersion,omitempty"`
}

type xrayRealitySettings struct {
	ServerName  string `json:"serverName"`
	Fingerprint string `json:"fingerprint"`
	PublicKey   string `json:"publicKey"`
	ShortID     string `json:"shortId"`
	SpiderX     string `json:"spiderX"`
}

type xrayXHTTPSettings struct {
	Host string `json:"host,omitempty"`
	Path string `json:"path,omitempty"`
	Mode string `json:"mode,omitempty"`
}

type xrayGRPCSettings struct {
	Authority   string `json:"authority,omitempty"`
	ServiceName string `json:"serviceName,omitempty"`
	MultiMode   bool   `json:"multiMode,omitempty"`
}

type xrayRoutingConfig struct {
	Rules []xrayRoutingRule `json:"rules"`
}

type xrayRoutingRule struct {
	Type        string   `json:"type"`
	InboundTag  []string `json:"inboundTag"`
	OutboundTag string   `json:"outboundTag"`
}

func (XrayAdapter) GenerateConfig(profile VLESSProfile, listenPort uint16) ([]byte, []string, error) {
	if listenPort == 0 {
		return nil, nil, ErrXrayConfigInvalid
	}
	if err := validateXrayProfile(profile); err != nil {
		return nil, nil, err
	}

	user := xrayVLESSUser{
		ID:         profile.UUID,
		Encryption: "none",
		Flow:       profile.Flow,
	}
	grpcAuthority := profile.Authority
	if profile.Transport == VLESSTransportGRPC && grpcAuthority == "" {
		grpcAuthority = profile.Host
	}
	stream := &xrayStreamSettings{
		Network:  string(profile.Transport),
		Security: string(profile.Security),
	}

	switch profile.Security {
	case VLESSSecurityTLS:
		stream.TLSSettings = &xrayTLSSettings{
			ServerName:  profile.ServerName,
			Fingerprint: profile.Fingerprint,
			ALPN:        append([]string(nil), profile.ALPN...),
		}
		if profile.Flow != "" {
			stream.TLSSettings.MinVersion = "1.3"
		}
	case VLESSSecurityReality:
		stream.RealitySettings = &xrayRealitySettings{
			ServerName:  profile.ServerName,
			Fingerprint: profile.Fingerprint,
			PublicKey:   profile.PublicKey,
			ShortID:     profile.ShortID,
			SpiderX:     profile.SpiderX,
		}
	}

	switch profile.Transport {
	case VLESSTransportXHTTP:
		stream.XHTTPSettings = &xrayXHTTPSettings{
			Host: profile.Host,
			Path: profile.Path,
			Mode: profile.Mode,
		}
	case VLESSTransportGRPC:
		stream.GRPCSettings = &xrayGRPCSettings{
			Authority:   grpcAuthority,
			ServiceName: profile.ServiceName,
			MultiMode:   profile.Mode == "multi",
		}
	}

	config := xrayRuntimeConfig{
		Log: xrayLogConfig{
			Access:   "none",
			Error:    "none",
			LogLevel: "none",
		},
		Inbounds: []xrayInbound{{
			Listen:   "127.0.0.1",
			Port:     listenPort,
			Protocol: "http",
			Settings: map[string]any{},
			Tag:      "local-proxy",
		}},
		Outbounds: []xrayOutbound{
			{
				Protocol: "vless",
				Tag:      "proxy",
				Settings: xrayVLESSSettings{
					VNext: []xrayVLESSVNext{{
						Address: profile.ServerAddress,
						Port:    profile.ServerPort,
						Users:   []xrayVLESSUser{user},
					}},
				},
				StreamSetting: stream,
			},
			{
				Protocol: "freedom",
				Tag:      "direct",
				Settings: map[string]any{},
			},
		},
		Routing: xrayRoutingConfig{
			Rules: []xrayRoutingRule{{
				Type:        "field",
				InboundTag:  []string{"local-proxy"},
				OutboundTag: "proxy",
			}},
		},
	}

	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("could not encode Xray configuration")
	}
	return append(encoded, '\n'), xraySensitiveValues(profile), nil
}

func validateXrayProfile(profile VLESSProfile) error {
	if !validHost(profile.ServerAddress) || profile.ServerPort == 0 ||
		!validUUID(profile.UUID) || profile.Encryption != "none" ||
		(profile.HeaderType != "" && profile.HeaderType != "none") {
		return ErrXrayConfigInvalid
	}
	if profile.Security != VLESSSecurityTLS && profile.Security != VLESSSecurityReality {
		return ErrXrayConfigUnsupported
	}
	if !validHost(profile.ServerName) ||
		(profile.Fingerprint != "" && !validFingerprint(profile.Fingerprint)) {
		return ErrXrayConfigInvalid
	}
	if profile.Flow != "" && !isVLESSVisionFlow(profile.Flow) {
		return ErrXrayConfigUnsupported
	}
	if profile.Flow != "" && profile.Transport != VLESSTransportTCP {
		return ErrXrayConfigUnsupported
	}
	if profile.Security == VLESSSecurityReality {
		if !validXrayRealityPublicKey(profile.PublicKey) || !validHex(profile.ShortID) ||
			(profile.SpiderX != "" && profile.SpiderX[0] != '/') ||
			profile.Fingerprint == "" {
			return ErrXrayConfigInvalid
		}
		if len(profile.ALPN) != 0 {
			return ErrXrayConfigUnsupported
		}
	} else if profile.PublicKey != "" || profile.ShortID != "" || profile.SpiderX != "" {
		return ErrXrayConfigUnsupported
	}
	for _, protocol := range profile.ALPN {
		if protocol == "" || !validVLESSParameterValue(protocol) {
			return ErrXrayConfigInvalid
		}
	}

	switch profile.Transport {
	case VLESSTransportTCP:
		if profile.Mode != "" || profile.Host != "" || profile.Authority != "" ||
			profile.Path != "" || profile.ServiceName != "" {
			return ErrXrayConfigUnsupported
		}
	case VLESSTransportXHTTP:
		if profile.Flow != "" || profile.Authority != "" || profile.ServiceName != "" ||
			!validModeForTransport(profile.Transport, profile.Mode) {
			return ErrXrayConfigUnsupported
		}
	case VLESSTransportGRPC:
		if profile.Flow != "" || profile.Path != "" ||
			!validModeForTransport(profile.Transport, profile.Mode) {
			return ErrXrayConfigUnsupported
		}
		if profile.Host != "" && profile.Authority != "" && profile.Host != profile.Authority {
			return ErrXrayConfigInvalid
		}
		authority := profile.Authority
		if authority == "" {
			authority = profile.Host
		}
		if authority != "" && !validVLESSAuthority(authority) {
			return ErrXrayConfigInvalid
		}
	default:
		return ErrXrayConfigUnsupported
	}
	if profile.Flow != "" && profile.Security != VLESSSecurityTLS &&
		profile.Security != VLESSSecurityReality {
		return ErrXrayConfigUnsupported
	}
	return nil
}

func validXrayRealityPublicKey(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}

func xraySensitiveValues(profile VLESSProfile) []string {
	values := []string{
		profile.ServerAddress,
		profile.UUID,
		profile.ServerName,
		profile.Fingerprint,
		profile.PublicKey,
		profile.ShortID,
		profile.SpiderX,
		profile.Host,
		profile.Authority,
		profile.Path,
		profile.ServiceName,
		profile.Flow,
		profile.Mode,
	}
	values = append(values, profile.ALPN...)
	return uniqueStrings(values)
}
