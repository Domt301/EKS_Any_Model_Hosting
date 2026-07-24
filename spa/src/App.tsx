import { useAuth } from './auth/useAuth';
import { LoginScreen } from './components/LoginScreen';
import { ChatView } from './components/ChatView';
import { Backdrop } from './components/Backdrop';

export default function App() {
  const { isAuthenticated, isLoading, user, error, login, logout, getAccessToken } = useAuth();

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
          <LoginScreen onLogin={login} error={error} />
        </div>
      ) : (
        <div className="shell">
          <ChatView
            user={user}
            getAccessToken={getAccessToken}
            onRequireLogin={login}
            onLogout={logout}
          />
        </div>
      )}
    </>
  );
}
