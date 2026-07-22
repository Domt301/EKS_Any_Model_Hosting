import { useAuth } from './auth/useAuth';
import { LoginScreen } from './components/LoginScreen';
import { ChatView } from './components/ChatView';

export default function App() {
  const { isAuthenticated, isLoading, user, error, login, logout, getAccessToken } = useAuth();

  if (isLoading) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>Loading…</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen onLogin={login} error={error} />;
  }

  return (
    <ChatView
      user={user}
      getAccessToken={getAccessToken}
      onRequireLogin={login}
      onLogout={logout}
    />
  );
}
