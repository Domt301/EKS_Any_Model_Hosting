/**
 * Application configuration.
 *
 * Reads Vite environment variables (import.meta.env), validates that the
 * required ones are present, and exposes a single typed `config` object.
 *
 * None of these values are secrets: the SPA uses OAuth2 Authorization Code
 * with PKCE (no client secret). All variables are prefixed with VITE_ so Vite
 * inlines them into the client bundle at build time.
 */

export interface AppConfig {
  awsRegion: string;
  cognitoUserPoolId: string;
  cognitoAppClientId: string;
  /** Full Hosted UI domain, e.g. https://xxx.auth.us-east-1.amazoncognito.com (no trailing slash). */
  cognitoDomain: string;
  redirectSignIn: string;
  redirectSignOut: string;
  /** FastAPI backend base URL (no trailing slash). */
  apiBaseUrl: string;
  modelName: string;
}

/** Trim any trailing slash so we can concatenate paths predictably. */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readEnv(name: string): string {
  const raw = import.meta.env[name as keyof ImportMetaEnv];
  return typeof raw === 'string' ? raw.trim() : '';
}

const REQUIRED_VARS = [
  'VITE_AWS_REGION',
  'VITE_COGNITO_USER_POOL_ID',
  'VITE_COGNITO_APP_CLIENT_ID',
  'VITE_COGNITO_DOMAIN',
  'VITE_COGNITO_REDIRECT_SIGN_IN',
  'VITE_COGNITO_REDIRECT_SIGN_OUT',
  'VITE_API_BASE_URL',
  'VITE_MODEL_NAME',
] as const;

function loadConfig(): AppConfig {
  const missing = REQUIRED_VARS.filter((name) => readEnv(name) === '');
  if (missing.length > 0) {
    // Surfacing this early makes misconfiguration obvious in dev and in the
    // Amplify build logs, rather than failing mysteriously at runtime.
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in the values.',
    );
  }

  return {
    awsRegion: readEnv('VITE_AWS_REGION'),
    cognitoUserPoolId: readEnv('VITE_COGNITO_USER_POOL_ID'),
    cognitoAppClientId: readEnv('VITE_COGNITO_APP_CLIENT_ID'),
    cognitoDomain: stripTrailingSlash(readEnv('VITE_COGNITO_DOMAIN')),
    redirectSignIn: readEnv('VITE_COGNITO_REDIRECT_SIGN_IN'),
    redirectSignOut: readEnv('VITE_COGNITO_REDIRECT_SIGN_OUT'),
    apiBaseUrl: stripTrailingSlash(readEnv('VITE_API_BASE_URL')),
    modelName: readEnv('VITE_MODEL_NAME'),
  };
}

export const config: AppConfig = loadConfig();
