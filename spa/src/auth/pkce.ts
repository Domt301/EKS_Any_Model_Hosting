/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) helpers plus random state.
 *
 * Uses the Web Crypto API (crypto.subtle) available in all modern browsers.
 * The S256 challenge method is used exclusively.
 */

/** Base64url-encode an ArrayBuffer (no padding, URL-safe alphabet). */
function base64UrlEncode(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a cryptographically random URL-safe string of `byteLength` bytes. */
function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes.buffer);
}

/**
 * Generate a high-entropy code_verifier per RFC 7636 (43-128 chars).
 * 32 random bytes -> 43 base64url chars.
 */
export function generateCodeVerifier(): string {
  return randomUrlSafe(32);
}

/** Derive the S256 code_challenge from a code_verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

/** Generate an opaque random `state` value for CSRF protection. */
export function generateState(): string {
  return randomUrlSafe(16);
}
