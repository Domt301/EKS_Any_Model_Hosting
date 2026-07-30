// Package auth decodes the connection bundle produced by the web app and keeps
// the Cognito access token fresh via the refresh_token grant.
package auth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/domt301/eks_any_model_hosting/cli/internal/config"
)

// SupportedBundleVersion is the bundle schema this CLI understands. It must
// match CLI_BUNDLE_VERSION in the SPA (spa/src/auth/cliBundle.ts).
const SupportedBundleVersion = 1

// bundle mirrors the camelCase JSON emitted by the SPA's buildCliBundle().
type bundle struct {
	Version       int    `json:"version"`
	APIBaseURL    string `json:"apiBaseUrl"`
	CognitoDomain string `json:"cognitoDomain"`
	ClientID      string `json:"clientId"`
	AWSRegion     string `json:"awsRegion"`
	ModelName     string `json:"modelName"`
	AccessToken   string `json:"accessToken"`
	RefreshToken  string `json:"refreshToken"`
	ExpiresAt     int64  `json:"expiresAt"`
}

// DecodeBundle parses a pasted connection token (base64url of JSON) into
// Credentials, validating the version and required fields.
func DecodeBundle(raw string) (*config.Credentials, error) {
	s := strings.TrimSpace(raw)
	// Tolerate accidental surrounding quotes or whitespace/newlines from paste.
	s = strings.Trim(s, "\"'")
	s = strings.Join(strings.Fields(s), "")
	if s == "" {
		return nil, errors.New("empty connection token")
	}

	data, err := decodeBase64URL(s)
	if err != nil {
		return nil, fmt.Errorf("connection token is not valid base64: %w", err)
	}

	var b bundle
	if err := json.Unmarshal(data, &b); err != nil {
		return nil, fmt.Errorf("connection token is not valid: %w", err)
	}
	if b.Version != SupportedBundleVersion {
		return nil, fmt.Errorf(
			"unsupported connection token version %d (this CLI supports %d) — update the CLI",
			b.Version, SupportedBundleVersion,
		)
	}
	if b.APIBaseURL == "" || b.AccessToken == "" {
		return nil, errors.New("connection token is missing required fields (api url / access token)")
	}

	return &config.Credentials{
		Version:       b.Version,
		APIBaseURL:    strings.TrimRight(b.APIBaseURL, "/"),
		CognitoDomain: strings.TrimRight(b.CognitoDomain, "/"),
		ClientID:      b.ClientID,
		AWSRegion:     b.AWSRegion,
		ModelName:     b.ModelName,
		AccessToken:   b.AccessToken,
		RefreshToken:  b.RefreshToken,
		ExpiresAt:     b.ExpiresAt,
	}, nil
}

// decodeBase64URL decodes URL-safe base64 with or without padding.
func decodeBase64URL(s string) ([]byte, error) {
	if data, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	return base64.URLEncoding.DecodeString(s)
}
