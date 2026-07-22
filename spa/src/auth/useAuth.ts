/**
 * React hook wrapping the Cognito auth flow.
 *
 * Exposes authentication state, the (id-token) display claims, a getter for a
 * valid access token, and login/logout/redirect-callback actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearTokens,
  decodeJwt,
  getValidAccessToken,
  handleRedirectCallback,
  loadTokens,
  loginRedirect,
  logoutRedirect,
  type UserClaims,
} from './cognito';

export interface AuthState {
  isAuthenticated: boolean;
  /** True while the initial redirect-callback / session bootstrap runs. */
  isLoading: boolean;
  user: UserClaims | null;
  error: string | null;
  login: () => void;
  logout: () => void;
  /** Return a valid access token (refreshing if needed) or null. */
  getAccessToken: () => Promise<string | null>;
}

export function useAuth(): AuthState {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<UserClaims | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guard against React 18 StrictMode double-invocation of the effect, which
  // would otherwise attempt the (single-use) code exchange twice.
  const bootstrapped = useRef(false);

  const deriveUserFromSession = useCallback(() => {
    const tokens = loadTokens();
    if (!tokens) {
      setIsAuthenticated(false);
      setUser(null);
      return;
    }
    // Prefer id token for display claims (email/username); fall back to access.
    const claims = decodeJwt(tokens.idToken || tokens.accessToken);
    setUser(claims);
    setIsAuthenticated(true);
  }, []);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      try {
        await handleRedirectCallback();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Login failed.');
      } finally {
        deriveUserFromSession();
        setIsLoading(false);
      }
    })();
  }, [deriveUserFromSession]);

  const login = useCallback(() => {
    setError(null);
    void loginRedirect();
  }, []);

  const logout = useCallback(() => {
    logoutRedirect();
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const token = await getValidAccessToken();
    if (!token) {
      // Session is gone or refresh failed — reflect that in state.
      clearTokens();
      setIsAuthenticated(false);
      setUser(null);
    }
    return token;
  }, []);

  return {
    isAuthenticated,
    isLoading,
    user,
    error,
    login,
    logout,
    getAccessToken,
  };
}
