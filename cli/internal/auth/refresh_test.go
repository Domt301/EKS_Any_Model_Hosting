package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/domt301/eks_any_model_hosting/cli/internal/config"
)

func TestEnsureFresh_NotExpiring(t *testing.T) {
	nowMillis = func() int64 { return 1_000_000 }
	defer func() { nowMillis = func() int64 { return 0 } }()

	creds := &config.Credentials{
		AccessToken: "old",
		ExpiresAt:   1_000_000 + 10*60*1000, // 10 minutes out
	}
	refreshed, err := EnsureFresh(context.Background(), creds, http.DefaultClient)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if refreshed {
		t.Fatal("should not refresh a token far from expiry")
	}
	if creds.AccessToken != "old" {
		t.Fatal("token should be unchanged")
	}
}

func TestEnsureFresh_RefreshesNearExpiry(t *testing.T) {
	nowMillis = func() int64 { return 1_000_000 }
	defer func() { nowMillis = func() int64 { return 0 } }()

	var gotForm string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		gotForm = r.Form.Encode()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"new-token","expires_in":3600,"token_type":"Bearer"}`))
	}))
	defer srv.Close()

	creds := &config.Credentials{
		CognitoDomain: srv.URL,
		ClientID:      "client-xyz",
		RefreshToken:  "refresh-abc",
		AccessToken:   "old",
		ExpiresAt:     1_000_000, // exactly now -> within skew
	}
	refreshed, err := EnsureFresh(context.Background(), creds, srv.Client())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !refreshed {
		t.Fatal("expected a refresh")
	}
	if creds.AccessToken != "new-token" {
		t.Errorf("AccessToken = %q, want new-token", creds.AccessToken)
	}
	if want := int64(1_000_000 + 3600*1000); creds.ExpiresAt != want {
		t.Errorf("ExpiresAt = %d, want %d", creds.ExpiresAt, want)
	}
	if creds.RefreshToken != "refresh-abc" {
		t.Error("refresh token should be preserved")
	}
	// Verify the grant parameters we sent.
	for _, want := range []string{"grant_type=refresh_token", "client_id=client-xyz", "refresh_token=refresh-abc"} {
		if !contains(gotForm, want) {
			t.Errorf("form %q missing %q", gotForm, want)
		}
	}
}

func TestEnsureFresh_NoRefreshToken(t *testing.T) {
	nowMillis = func() int64 { return 1_000_000 }
	defer func() { nowMillis = func() int64 { return 0 } }()

	creds := &config.Credentials{AccessToken: "old", ExpiresAt: 1_000_000}
	_, err := EnsureFresh(context.Background(), creds, http.DefaultClient)
	if err != ErrNoRefreshToken {
		t.Fatalf("err = %v, want ErrNoRefreshToken", err)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (indexOf(haystack, needle) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
