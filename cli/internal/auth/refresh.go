package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/domt301/eks_any_model_hosting/cli/internal/config"
)

// refreshSkew refreshes the access token this long before it actually expires,
// mirroring EXPIRY_SKEW_SECONDS in the SPA.
const refreshSkew = 60 * time.Second

// ErrNoRefreshToken indicates the stored bundle had no refresh token, so the
// caller must prompt the user to log in again.
var ErrNoRefreshToken = errors.New("no refresh token available; run `llama-cli login` again")

// nowMillis is overridable in tests.
var nowMillis = func() int64 { return time.Now().UnixMilli() }

type cognitoTokenResponse struct {
	AccessToken string `json:"access_token"`
	IDToken     string `json:"id_token"`
	ExpiresIn   int    `json:"expires_in"`
	TokenType   string `json:"token_type"`
}

// isExpiring reports whether the access token is at or past its refresh point.
func isExpiring(creds *config.Credentials) bool {
	return nowMillis() >= creds.ExpiresAt-refreshSkew.Milliseconds()
}

// EnsureFresh refreshes the access token in place if it is near expiry. It
// returns true when a refresh occurred (so the caller can persist). A missing
// refresh token or endpoint yields ErrNoRefreshToken.
func EnsureFresh(ctx context.Context, creds *config.Credentials, hc *http.Client) (bool, error) {
	if !isExpiring(creds) {
		return false, nil
	}
	if creds.RefreshToken == "" || creds.CognitoDomain == "" || creds.ClientID == "" {
		return false, ErrNoRefreshToken
	}
	if err := refresh(ctx, creds, hc); err != nil {
		return false, err
	}
	return true, nil
}

// refresh performs the Cognito refresh_token grant and updates creds in place.
func refresh(ctx context.Context, creds *config.Credentials, hc *http.Client) error {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {creds.ClientID},
		"refresh_token": {creds.RefreshToken},
	}
	endpoint := strings.TrimRight(creds.CognitoDomain, "/") + "/oauth2/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("token refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("token refresh failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var tr cognitoTokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return fmt.Errorf("token refresh returned an unexpected response: %w", err)
	}
	if tr.AccessToken == "" {
		return errors.New("token refresh returned no access token")
	}

	creds.AccessToken = tr.AccessToken
	if tr.ExpiresIn > 0 {
		creds.ExpiresAt = nowMillis() + int64(tr.ExpiresIn)*1000
	}
	// The refresh grant does not return a new refresh token; keep the old one.
	return nil
}
