// Package client talks to the Llama Pilot FastAPI backend: streaming chat
// completions (SSE) plus the small identity/model/session helper endpoints.
//
// The SSE contract matches services/api/app/inference.py:
//
//	event: token   data: {"text":"..."}
//	event: usage   data: {"prompt_tokens":N,"completion_tokens":M}
//	event: done    data: {}
//	event: error   data: {"code":"...","message":"..."}
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Client is a thin HTTP client bound to one deployment's API base URL.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New returns a Client for the given base URL (trailing slash trimmed).
func New(baseURL string, hc *http.Client) *Client {
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: hc}
}

// Message is a single user/assistant turn.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Usage is the token accounting emitted at end of stream.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// ChatRequest is the public chat-completion request.
type ChatRequest struct {
	Messages        []Message
	Temperature     float64
	MaxOutputTokens int
	SessionID       string
}

// StreamCallbacks receives streamed output.
type StreamCallbacks struct {
	OnToken func(string)
	OnUsage func(Usage)
}

// APIError is a structured error returned by the backend (SSE or JSON envelope).
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	return fmt.Sprintf("request failed (%d)", e.Status)
}

// ErrUnauthorized is returned on a 401 so callers can prompt re-login.
var ErrUnauthorized = errors.New("unauthorized")

type chatBody struct {
	Messages        []Message `json:"messages"`
	Temperature     float64   `json:"temperature"`
	MaxOutputTokens int       `json:"max_output_tokens"`
	Stream          bool      `json:"stream"`
	SessionID       string    `json:"session_id,omitempty"`
}

// StreamChat streams a chat completion, delivering tokens through cb. It returns
// nil on a clean `done`, or an *APIError / ErrUnauthorized on failure.
func (c *Client) StreamChat(ctx context.Context, accessToken string, req ChatRequest, cb StreamCallbacks) error {
	body := chatBody{
		Messages:        req.Messages,
		Temperature:     req.Temperature,
		MaxOutputTokens: req.MaxOutputTokens,
		Stream:          true,
		SessionID:       req.SessionID,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return errorFromResponse(resp)
	}

	return ParseSSE(resp.Body, func(event, data string) (bool, error) {
		switch event {
		case "token":
			var p struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal([]byte(data), &p); err == nil && p.Text != "" {
				if cb.OnToken != nil {
					cb.OnToken(p.Text)
				}
			}
			return false, nil
		case "usage":
			var u Usage
			if err := json.Unmarshal([]byte(data), &u); err == nil && cb.OnUsage != nil {
				cb.OnUsage(u)
			}
			return false, nil
		case "done":
			return true, nil
		case "error":
			var e struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal([]byte(data), &e)
			return true, &APIError{Code: e.Code, Message: e.Message}
		default:
			if strings.TrimSpace(data) == "[DONE]" {
				return true, nil
			}
			return false, nil
		}
	})
}

// Me is the identity returned by GET /api/v1/me.
type Me struct {
	Sub      string `json:"sub"`
	TokenUse string `json:"token_use"`
	ClientID string `json:"client_id"`
	Scope    string `json:"scope"`
}

// Me fetches the caller identity.
func (c *Client) Me(ctx context.Context, accessToken string) (*Me, error) {
	var me Me
	if err := c.getJSON(ctx, accessToken, "/api/v1/me", &me); err != nil {
		return nil, err
	}
	return &me, nil
}

// Models returns the public model ids from GET /api/v1/models.
func (c *Client) Models(ctx context.Context, accessToken string) ([]string, error) {
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := c.getJSON(ctx, accessToken, "/api/v1/models", &list); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(list.Data))
	for _, m := range list.Data {
		ids = append(ids, m.ID)
	}
	return ids, nil
}

// ForgetSession asks the server to drop a conversation's in-memory context.
func (c *Client) ForgetSession(ctx context.Context, accessToken, sessionID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.BaseURL+"/api/v1/sessions/"+sessionID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	return nil
}

func (c *Client) getJSON(ctx context.Context, accessToken, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errorFromResponse(resp)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// errorFromResponse maps a non-2xx response to ErrUnauthorized or an *APIError.
func errorFromResponse(resp *http.Response) error {
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err == nil && (env.Error.Message != "" || env.Error.Code != "") {
		return &APIError{Status: resp.StatusCode, Code: env.Error.Code, Message: env.Error.Message}
	}
	msg := strings.TrimSpace(string(body))
	if msg == "" {
		msg = fmt.Sprintf("request failed (%d)", resp.StatusCode)
	}
	return &APIError{Status: resp.StatusCode, Message: msg}
}
