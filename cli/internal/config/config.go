// Package config persists the CLI's connection credentials on disk.
//
// Credentials live at $XDG_CONFIG_HOME/llama-pilot/credentials.json (falling
// back to ~/.config/llama-pilot/credentials.json) with 0600 permissions. They
// hold the deployment endpoints plus the current Cognito tokens, so the CLI is
// zero-config after a single `login`.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Credentials is the on-disk credential + endpoint record.
type Credentials struct {
	Version       int    `json:"version"`
	APIBaseURL    string `json:"api_base_url"`
	CognitoDomain string `json:"cognito_domain"`
	ClientID      string `json:"client_id"`
	AWSRegion     string `json:"aws_region"`
	ModelName     string `json:"model_name"`
	AccessToken   string `json:"access_token"`
	RefreshToken  string `json:"refresh_token,omitempty"`
	// ExpiresAt is the absolute access-token expiry as epoch milliseconds.
	ExpiresAt int64 `json:"expires_at"`
}

const (
	appDir   = "llama-pilot"
	credFile = "credentials.json"
)

// Dir returns the directory holding the credentials file.
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, appDir), nil
}

// Path returns the full path to the credentials file.
func Path() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, credFile), nil
}

// Load reads stored credentials. It returns (nil, nil) when none exist yet.
func Load() (*Credentials, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("credentials file is corrupt (%s): %w", path, err)
	}
	return &creds, nil
}

// Save writes credentials atomically with 0600 permissions.
func Save(creds *Credentials) error {
	dir, err := Dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, credFile)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	// Rename is atomic on the same filesystem; ensure final mode is 0600.
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// Clear removes the stored credentials. Missing file is not an error.
func Clear() error {
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
