package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStreamChat_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/chat/completions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("auth header = %q", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: token\ndata: {\"text\":\"Hi\"}\n\n" +
			"event: token\ndata: {\"text\":\"!\"}\n\n" +
			"event: usage\ndata: {\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}\n\n" +
			"event: done\ndata: {}\n\n"))
	}))
	defer srv.Close()

	c := New(srv.URL, srv.Client())
	var got strings.Builder
	var usage Usage
	err := c.StreamChat(context.Background(), "tok", ChatRequest{
		Messages:  []Message{{Role: "user", Content: "hey"}},
		SessionID: "cli-1",
	}, StreamCallbacks{
		OnToken: func(s string) { got.WriteString(s) },
		OnUsage: func(u Usage) { usage = u },
	})
	if err != nil {
		t.Fatalf("StreamChat error: %v", err)
	}
	if got.String() != "Hi!" {
		t.Errorf("tokens = %q, want %q", got.String(), "Hi!")
	}
	if usage.TotalTokens != 7 {
		t.Errorf("usage.TotalTokens = %d, want 7", usage.TotalTokens)
	}
}

func TestStreamChat_ErrorEvent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: error\ndata: {\"code\":\"MODEL_TIMEOUT\",\"message\":\"The model timed out.\"}\n\n"))
	}))
	defer srv.Close()

	c := New(srv.URL, srv.Client())
	err := c.StreamChat(context.Background(), "tok", ChatRequest{
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, StreamCallbacks{OnToken: func(string) {}})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.Code != "MODEL_TIMEOUT" {
		t.Errorf("code = %q", apiErr.Code)
	}
}

func TestStreamChat_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"code":"UNAUTHORIZED","message":"Missing bearer token"}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, srv.Client())
	err := c.StreamChat(context.Background(), "bad", ChatRequest{
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, StreamCallbacks{})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestSendsSessionIDAndOmitsWhenEmpty(t *testing.T) {
	var body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, r.ContentLength)
		r.Body.Read(b)
		body = string(b)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: done\ndata: {}\n\n"))
	}))
	defer srv.Close()
	c := New(srv.URL, srv.Client())

	_ = c.StreamChat(context.Background(), "t", ChatRequest{
		Messages: []Message{{Role: "user", Content: "hi"}}, SessionID: "cli-42",
	}, StreamCallbacks{})
	if !strings.Contains(body, `"session_id":"cli-42"`) {
		t.Errorf("body missing session_id: %s", body)
	}
	if !strings.Contains(body, `"stream":true`) {
		t.Errorf("body missing stream flag: %s", body)
	}

	_ = c.StreamChat(context.Background(), "t", ChatRequest{
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, StreamCallbacks{})
	if strings.Contains(body, "session_id") {
		t.Errorf("session_id should be omitted when empty: %s", body)
	}
}

func TestMe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"sub":"user-1","token_use":"access","client_id":"c1","scope":"openid"}`))
	}))
	defer srv.Close()
	c := New(srv.URL, srv.Client())
	me, err := c.Me(context.Background(), "tok")
	if err != nil {
		t.Fatalf("Me error: %v", err)
	}
	if me.Sub != "user-1" || me.ClientID != "c1" {
		t.Errorf("me = %+v", me)
	}
}
