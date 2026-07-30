package config

import (
	"os"
	"runtime"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	want := &Credentials{
		Version:       1,
		APIBaseURL:    "https://api.example.com",
		CognitoDomain: "https://auth.example.com",
		ClientID:      "client-1",
		AWSRegion:     "us-east-1",
		ModelName:     "llama-pilot",
		AccessToken:   "access",
		RefreshToken:  "refresh",
		ExpiresAt:     1700000000000,
	}
	if err := Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got == nil {
		t.Fatal("Load returned nil")
	}
	if *got != *want {
		t.Errorf("round-trip mismatch:\n got  %+v\n want %+v", got, want)
	}
}

func TestLoadMissingReturnsNil(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for missing creds, got %+v", got)
	}
}

func TestSaveUses0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix file modes not meaningful on windows")
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := Save(&Credentials{Version: 1, APIBaseURL: "x", AccessToken: "y"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	path, _ := Path()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 600", perm)
	}
}

func TestClear(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	_ = Save(&Credentials{Version: 1, APIBaseURL: "x", AccessToken: "y"})
	if err := Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	got, _ := Load()
	if got != nil {
		t.Fatal("creds still present after Clear")
	}
	// Clearing again is not an error.
	if err := Clear(); err != nil {
		t.Fatalf("second Clear: %v", err)
	}
}
