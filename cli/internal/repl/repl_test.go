package repl

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/domt301/eks_any_model_hosting/cli/internal/client"
	"github.com/domt301/eks_any_model_hosting/cli/internal/config"
	"github.com/domt301/eks_any_model_hosting/cli/internal/filectx"
)

func stubServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: token\ndata: {\"text\":\"Hello \"}\n\n" +
			"event: token\ndata: {\"text\":\"there\"}\n\n" +
			"event: done\ndata: {}\n\n"))
	}))
}

func testDeps(t *testing.T, srv *httptest.Server, out *bytes.Buffer, in string) Deps {
	t.Helper()
	creds := &config.Credentials{
		Version:     1,
		APIBaseURL:  srv.URL,
		ModelName:   "llama-pilot",
		AccessToken: "tok",
		// Far-future expiry so no refresh is attempted.
		ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
	}
	return Deps{
		Client: client.New(srv.URL, srv.Client()),
		Creds:  creds,
		HTTP:   srv.Client(),
		Save:   func(*config.Credentials) error { return nil },
		In:     strings.NewReader(in),
		Out:    out,
	}
}

func TestOneShot(t *testing.T) {
	srv := stubServer(t)
	defer srv.Close()
	var out bytes.Buffer
	if err := OneShot(context.Background(), testDeps(t, srv, &out, ""), "hi", nil); err != nil {
		t.Fatalf("OneShot error: %v", err)
	}
	if !strings.Contains(out.String(), "Hello there") {
		t.Errorf("output = %q, want streamed tokens", out.String())
	}
}

func TestRun_StreamsThenExitsOnEOF(t *testing.T) {
	srv := stubServer(t)
	defer srv.Close()
	var out bytes.Buffer
	// One message, then EOF (input reader ends) exits the loop cleanly.
	deps := testDeps(t, srv, &out, "what's up\n")
	if err := Run(context.Background(), deps); err != nil {
		t.Fatalf("Run error: %v", err)
	}
	s := out.String()
	if !strings.Contains(s, "Hello there") {
		t.Errorf("missing streamed reply in %q", s)
	}
	if !strings.Contains(s, "Llama Pilot CLI") {
		t.Errorf("missing banner in %q", s)
	}
}

func TestOneShot_AttachesInlineFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "greet.go"), []byte("package greet // MARKER"), 0o644); err != nil {
		t.Fatal(err)
	}

	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		r.Body.Read(b)
		body = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: done\ndata: {}\n\n"))
	}))
	defer srv.Close()

	var out bytes.Buffer
	d := testDeps(t, srv, &out, "")
	d.CtxOptions = filectx.Options{Root: dir}
	if err := OneShot(context.Background(), d, "what does @greet.go do?", nil); err != nil {
		t.Fatalf("OneShot error: %v", err)
	}
	if !strings.Contains(body, "MARKER") {
		t.Errorf("file content not in request body: %s", body)
	}
	if !strings.Contains(out.String(), "attached greet.go") {
		t.Errorf("missing attach note in output: %q", out.String())
	}
}

func TestOneShot_AttachesViaFlag(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "util.py"), []byte("# FLAGFILE"), 0o644); err != nil {
		t.Fatal(err)
	}
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		r.Body.Read(b)
		body = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: done\ndata: {}\n\n"))
	}))
	defer srv.Close()

	var out bytes.Buffer
	d := testDeps(t, srv, &out, "")
	d.CtxOptions = filectx.Options{Root: dir}
	if err := OneShot(context.Background(), d, "review", []string{"util.py"}); err != nil {
		t.Fatalf("OneShot error: %v", err)
	}
	if !strings.Contains(body, "FLAGFILE") {
		t.Errorf("flag-attached file not in body: %s", body)
	}
}

func TestRun_HelpCommand(t *testing.T) {
	srv := stubServer(t)
	defer srv.Close()
	var out bytes.Buffer
	deps := testDeps(t, srv, &out, "/help\n/exit\n")
	if err := Run(context.Background(), deps); err != nil {
		t.Fatalf("Run error: %v", err)
	}
	if !strings.Contains(out.String(), "Commands:") {
		t.Errorf("help not printed: %q", out.String())
	}
}
