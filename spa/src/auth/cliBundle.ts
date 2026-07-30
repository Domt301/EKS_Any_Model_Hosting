/**
 * CLI connection bundle.
 *
 * Packs everything the `llama-cli` terminal client needs to talk to this
 * deployment into a single, copy-pasteable string: the API + Cognito endpoints
 * and the current tokens. The CLI decodes it once, then keeps the session alive
 * by refreshing the access token itself (public client, no secret — the same
 * refresh_token grant the SPA uses in cognito.ts).
 *
 * The bundle is base64url(JSON) — opaque enough not to be mistaken for a raw
 * JWT, but trivially decodable by the CLI. It is NOT encrypted: it carries a
 * refresh token, so it is a bearer credential and should be treated like one.
 */

import { config } from '../config';
import type { StoredTokens } from './cognito';

/** Bump when the bundle shape changes so the CLI can reject unknown versions. */
export const CLI_BUNDLE_VERSION = 1;

export interface CliBundle {
  version: number;
  /** FastAPI base URL (no trailing slash). */
  apiBaseUrl: string;
  /** Cognito Hosted UI domain, used for the refresh_token grant. */
  cognitoDomain: string;
  /** Public app client id (no secret). */
  clientId: string;
  awsRegion: string;
  modelName: string;
  accessToken: string;
  refreshToken?: string;
  /** Absolute access-token expiry as epoch milliseconds. */
  expiresAt: number;
}

/** UTF-8-safe base64url encode (no padding, URL-safe alphabet). */
function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build the opaque bundle string the user pastes into the CLI. */
export function buildCliBundle(tokens: StoredTokens): string {
  const bundle: CliBundle = {
    version: CLI_BUNDLE_VERSION,
    apiBaseUrl: config.apiBaseUrl,
    cognitoDomain: config.cognitoDomain,
    clientId: config.cognitoAppClientId,
    awsRegion: config.awsRegion,
    modelName: config.modelName,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
  return base64UrlEncode(JSON.stringify(bundle));
}
