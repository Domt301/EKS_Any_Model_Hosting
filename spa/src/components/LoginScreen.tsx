import { config } from '../config';
import { OrbAvatar } from './Backdrop';

interface LoginScreenProps {
  onLogin: () => void;
  error?: string | null;
}

export function LoginScreen({ onLogin, error }: LoginScreenProps) {
  return (
    <div className="login">
      <div className="login__card">
        <OrbAvatar size="lg" />
        <h1 className="login__title">Llama Pilot</h1>
        <p className="login__subtitle">
          A self-hosted AI agent running on your own Amazon EKS cluster.
          Private by design — your prompts never leave your infrastructure.
        </p>
        <span className="chip">{config.modelName}</span>

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button type="button" className="btn btn--primary login__btn" onClick={onLogin}>
          Enter the console
        </button>

        <p className="login__hint">Secured with Amazon Cognito · OAuth2 + PKCE</p>
      </div>
    </div>
  );
}
