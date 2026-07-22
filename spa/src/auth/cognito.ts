/**
 * Cognito Hosted UI OAuth2 (Authorization Code + PKCE) client.
 *
 * No client secret is used — this is a public SPA client. All token material
 * lives in sessionStorage (cleared when the tab/window closes) which keeps the
 * blast radius small compared to localStorage.
 */

import { config } from '../config';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './pkce';

// --- sessionStorage keys ---------------------------------------------------
const PKCE_VERIFIER_KEY = 'llama_pilot.pkce_verifier';
const OAUTH_STATE_KEY = 'llama_pilot.oauth_state';
const TOKENS_KEY = 'llama_pilot.tokens';

/** Refresh the access token this many seconds before it actually expires. */
const EXPIRY_SKEW_SECONDS = 60;

export interface StoredTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  /** Absolute expiry as epoch milliseconds. */
  expiresAt: number;
  tokenType: string;
}

interface CognitoTokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/** Minimal set of JWT claims we surface for display. */
export interface UserClaims {
  sub?: string;
  email?: string;
  username?: string;
  [key: string]: unknown;
}

// --- Token storage ---------------------------------------------------------

export function loadTokens(): StoredTokens | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: StoredTokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
}

function toStoredTokens(res: CognitoTokenResponse, previousRefresh?: string): StoredTokens {
  return {
    accessToken: res.access_token,
    idToken: res.id_token,
    // A refresh_token is not returned by the refresh grant; keep the old one.
    refreshToken: res.refresh_token ?? previousRefresh,
    expiresAt: Date.now() + res.expires_in * 1000,
    tokenType: res.token_type || 'Bearer',
  };
}

// --- JWT decode (display only; NOT verification) ---------------------------

/**
 * Decode a JWT payload without verifying its signature. This is purely to read
 * display claims (e.g. email) client-side. The backend performs real JWKS
 * verification — never trust these values for authorization decisions.
 */
export function decodeJwt(token: string): UserClaims {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    );
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json) as UserClaims;
  } catch {
    return {};
  }
}

// --- Login redirect --------------------------------------------------------

/**
 * Begin the login flow: generate PKCE material + state, stash them in
 * sessionStorage, then redirect the browser to the Cognito authorize endpoint.
 */
export async function loginRedirect(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();

  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(OAUTH_STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognitoAppClientId,
    redirect_uri: config.redirectSignIn,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  window.location.assign(`${config.cognitoDomain}/oauth2/authorize?${params.toString()}`);
}

// --- Redirect callback -----------------------------------------------------

/**
 * If the current URL carries an authorization `code`, exchange it for tokens.
 * Verifies `state`, strips the query string from the URL on success, and
 * returns the stored tokens. Returns null when there is no code to handle.
 */
export async function handleRedirectCallback(): Promise<StoredTokens | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    // Clean the URL so a refresh doesn't re-trigger the error.
    stripAuthParamsFromUrl();
    throw new Error(
      url.searchParams.get('error_description') || `Login failed: ${errorParam}`,
    );
  }

  if (!code) return null;

  const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);

  if (!expectedState || returnedState !== expectedState) {
    stripAuthParamsFromUrl();
    throw new Error('OAuth state mismatch — possible CSRF, aborting login.');
  }
  if (!verifier) {
    stripAuthParamsFromUrl();
    throw new Error('Missing PKCE verifier — please try signing in again.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.cognitoAppClientId,
    code,
    redirect_uri: config.redirectSignIn,
    code_verifier: verifier,
  });

  const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    stripAuthParamsFromUrl();
    const detail = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}). ${detail}`);
  }

  const json = (await res.json()) as CognitoTokenResponse;
  const tokens = toStoredTokens(json);
  saveTokens(tokens);

  // One-time material; no longer needed once tokens are obtained.
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);

  stripAuthParamsFromUrl();
  return tokens;
}

/** Remove ?code/?state/?error from the address bar without a navigation. */
function stripAuthParamsFromUrl(): void {
  const url = new URL(window.location.href);
  ['code', 'state', 'error', 'error_description'].forEach((k) =>
    url.searchParams.delete(k),
  );
  const clean = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '') + url.hash;
  window.history.replaceState({}, document.title, clean);
}

// --- Refresh ---------------------------------------------------------------

function isExpiringSoon(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expiresAt - EXPIRY_SKEW_SECONDS * 1000;
}

/** Refresh the access token using the stored refresh_token. */
export async function refreshTokens(tokens: StoredTokens): Promise<StoredTokens> {
  if (!tokens.refreshToken) {
    throw new Error('No refresh token available.');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.cognitoAppClientId,
    refresh_token: tokens.refreshToken,
  });

  const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}).`);
  }

  const json = (await res.json()) as CognitoTokenResponse;
  const next = toStoredTokens(json, tokens.refreshToken);
  saveTokens(next);
  return next;
}

/**
 * Return a valid (non-expiring) access token, refreshing transparently if the
 * current one is near expiry. Returns null if there is no session or refresh
 * fails (caller should trigger re-login).
 */
export async function getValidAccessToken(): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  if (!isExpiringSoon(tokens)) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    return null;
  }

  try {
    const refreshed = await refreshTokens(tokens);
    return refreshed.accessToken;
  } catch {
    clearTokens();
    return null;
  }
}

// --- Logout ----------------------------------------------------------------

/** Clear local session and redirect to the Cognito logout endpoint. */
export function logoutRedirect(): void {
  clearTokens();
  const params = new URLSearchParams({
    client_id: config.cognitoAppClientId,
    logout_uri: config.redirectSignOut,
  });
  window.location.assign(`${config.cognitoDomain}/logout?${params.toString()}`);
}
