import { useCallback, useState } from 'react';
import { useAuth } from './auth/useAuth';
import { LoginScreen } from './components/LoginScreen';
import { ChatView } from './components/ChatView';
import { CliAccessView } from './components/CliAccessView';
import { Backdrop } from './components/Backdrop';

// Set before redirecting to Cognito so we return to the CLI page after the
// OAuth round-trip (the redirect lands on `/` and drops the URL hash).
const CLI_INTENT_KEY = 'llama_pilot.cli_intent';

/** Enter CLI mode via `#cli` in the URL or a persisted intent flag. */
function initialCliMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hash.replace(/^#/, '') === 'cli') return true;
  try {
    return sessionStorage.getItem(CLI_INTENT_KEY) === '1';
  } catch {
    return false;
  }
}

export default function App() {
  const { isAuthenticated, isLoading, user, error, login, logout, getAccessToken } = useAuth();
  const [cliMode, setCliMode] = useState<boolean>(initialCliMode);

  const enterCli = useCallback(() => {
    try {
      sessionStorage.setItem(CLI_INTENT_KEY, '1');
    } catch {
      /* ignore */
    }
    setCliMode(true);
  }, []);

  const exitCli = useCallback(() => {
    try {
      sessionStorage.removeItem(CLI_INTENT_KEY);
    } catch {
      /* ignore */
    }
    if (window.location.hash) {
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.search,
      );
    }
    setCliMode(false);
  }, []);

  // Login that returns to the CLI page afterwards.
  const loginForCli = useCallback(() => {
    try {
      sessionStorage.setItem(CLI_INTENT_KEY, '1');
    } catch {
      /* ignore */
    }
    login();
  }, [login]);

  return (
    <>
      <Backdrop />
      {isLoading ? (
        <div className="app-loading" role="status" aria-live="polite">
          <span className="orb-avatar orb-avatar--lg is-thinking" aria-hidden="true">
            <span className="orb-avatar__core" />
          </span>
          <span>Initializing agent…</span>
        </div>
      ) : !isAuthenticated ? (
        <div className="shell">
          <LoginScreen onLogin={cliMode ? loginForCli : login} error={error} cliMode={cliMode} />
        </div>
      ) : (
        <div className="shell">
          {cliMode ? (
            <CliAccessView
              getAccessToken={getAccessToken}
              onBackToChat={exitCli}
              onRequireLogin={loginForCli}
            />
          ) : (
            <ChatView
              user={user}
              getAccessToken={getAccessToken}
              onRequireLogin={login}
              onLogout={logout}
              onCliAccess={enterCli}
            />
          )}
        </div>
      )}
    </>
  );
}
