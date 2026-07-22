# ADR-006: Use Cognito authorization-code flow with PKCE

**Status:** Accepted

## Context
The SPA is a public browser client and cannot hold a secret. It needs a standard,
secure OAuth2 flow and must send access tokens the FastAPI backend can validate.

## Decision
Use an Amazon Cognito user pool with a **public app client (no secret)**,
**authorization-code grant + PKCE** only, implicit grant disabled, scopes
`openid email profile`, token revocation enabled, and short (60-minute) access
tokens. FastAPI validates the **access** token (signature via JWKS, issuer,
expiry, `token_use == access`, `client_id`).

## Alternatives considered
- **Implicit grant:** Deprecated and less secure; tokens exposed in URLs.
- **Client with secret:** Impossible to protect in a browser SPA.
- **Self-managed auth:** Unnecessary; Cognito provides the hosted UI, JWKS, and
  user management.

## Consequences
- No secret to leak; PKCE mitigates code interception.
- The SPA implements the PKCE dance (verifier/challenge, state) directly.
- Callback/logout URLs must include the Amplify domain — handled by the two-phase
  deploy.

## Revisit when
- An enterprise IdP (SAML/OIDC federation) or stricter MFA posture is required.
