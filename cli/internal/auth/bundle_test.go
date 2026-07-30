package auth

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// encodeBundle mirrors the SPA's buildCliBundle (base64url of JSON, no padding).
func encodeBundle(t *testing.T, v map[string]any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func validBundle() map[string]any {
	return map[string]any{
		"version":       SupportedBundleVersion,
		"apiBaseUrl":    "https://api.example.com/",
		"cognitoDomain": "https://auth.example.com",
		"clientId":      "abc123",
		"awsRegion":     "us-east-1",
		"modelName":     "llama-pilot",
		"accessToken":   "access.jwt.token",
		"refreshToken":  "refresh-token",
		"expiresAt":     int64(1700000000000),
	}
}

func TestDecodeBundle_Valid(t *testing.T) {
	creds, err := DecodeBundle(encodeBundle(t, validBundle()))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if creds.APIBaseURL != "https://api.example.com" { // trailing slash trimmed
		t.Errorf("APIBaseURL = %q, want trimmed", creds.APIBaseURL)
	}
	if creds.AccessToken != "access.jwt.token" {
		t.Errorf("AccessToken = %q", creds.AccessToken)
	}
	if creds.RefreshToken != "refresh-token" {
		t.Errorf("RefreshToken = %q", creds.RefreshToken)
	}
	if creds.ClientID != "abc123" || creds.CognitoDomain != "https://auth.example.com" {
		t.Errorf("client/domain mismatch: %+v", creds)
	}
	if creds.ExpiresAt != 1700000000000 {
		t.Errorf("ExpiresAt = %d", creds.ExpiresAt)
	}
}

func TestDecodeBundle_TrimsWhitespaceAndQuotes(t *testing.T) {
	enc := encodeBundle(t, validBundle())
	// Simulate a messy paste with quotes, spaces and a stray newline.
	messy := "  \"" + enc[:10] + "\n" + enc[10:] + "\"  "
	if _, err := DecodeBundle(messy); err != nil {
		t.Fatalf("expected tolerant decode, got: %v", err)
	}
}

func TestDecodeBundle_RejectsBadVersion(t *testing.T) {
	b := validBundle()
	b["version"] = 999
	if _, err := DecodeBundle(encodeBundle(t, b)); err == nil {
		t.Fatal("expected version error")
	}
}

func TestDecodeBundle_RejectsMissingFields(t *testing.T) {
	b := validBundle()
	delete(b, "accessToken")
	if _, err := DecodeBundle(encodeBundle(t, b)); err == nil {
		t.Fatal("expected missing-field error")
	}
}

func TestDecodeBundle_RejectsGarbage(t *testing.T) {
	if _, err := DecodeBundle("not-base64-@@@"); err == nil {
		t.Fatal("expected base64 error")
	}
	if _, err := DecodeBundle(""); err == nil {
		t.Fatal("expected empty error")
	}
}
