import { config } from '../config';

interface LoginScreenProps {
  onLogin: () => void;
  error?: string | null;
}

export function LoginScreen({ onLogin, error }: LoginScreenProps) {
  return (
    <div className="login">
      <div className="login__card">
        <h1 className="login__title">Llama Pilot</h1>
        <p className="login__subtitle">
          Self-hosted chat, secured with Amazon Cognito.
        </p>
        <span className="badge badge--model">{config.modelName}</span>

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button type="button" className="btn btn--primary login__btn" onClick={onLogin}>
          Sign in
        </button>

        <p className="login__hint">
          You will be redirected to the secure hosted sign-in page.
        </p>
      </div>
    </div>
  );
}
