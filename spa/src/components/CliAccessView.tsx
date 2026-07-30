import { useCallback, useEffect, useState } from 'react';
import { config } from '../config';
import { loadTokens } from '../auth/cognito';
import { buildCliBundle } from '../auth/cliBundle';
import { OrbAvatar } from './Backdrop';

interface CliAccessViewProps {
  /** Returns a valid (refreshed) access token or null; refreshing persists it. */
  getAccessToken: () => Promise<string | null>;
  onBackToChat: () => void;
  onRequireLogin: () => void;
}

function formatCountdown(msLeft: number): string {
  if (msLeft <= 0) return 'expired';
  const total = Math.floor(msLeft / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

/**
 * "CLI access" page. After the normal Cognito login, this surfaces a
 * copy-pasteable connection bundle (endpoints + tokens) for the `llama-cli`
 * terminal client. The token is never shown anywhere else in the app.
 */
export function CliAccessView({ getAccessToken, onBackToChat, onRequireLogin }: CliAccessViewProps) {
  const [bundle, setBundle] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [copied, setCopied] = useState<'bundle' | 'token' | null>(null);
  const [showToken, setShowToken] = useState(false);

  // Refresh (if needed) then read the full token set to build the bundle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getAccessToken();
      if (cancelled) return;
      if (!token) {
        onRequireLogin();
        return;
      }
      const tokens = loadTokens();
      if (!tokens) {
        onRequireLogin();
        return;
      }
      setBundle(buildCliBundle(tokens));
      setAccessToken(tokens.accessToken);
      setExpiresAt(tokens.expiresAt);
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessToken, onRequireLogin]);

  // Live expiry countdown.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const copy = useCallback(async (value: string, which: 'bundle' | 'token') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1800);
    } catch {
      // Clipboard blocked (insecure context / permissions): fall back to select.
      setCopied(null);
    }
  }, []);

  const appOrigin = window.location.origin;
  const msLeft = expiresAt ? expiresAt - now : 0;

  return (
    <div className="cli">
      <div className="cli__card">
        <header className="cli__head">
          <OrbAvatar size="lg" />
          <div>
            <h1 className="cli__title">CLI access</h1>
            <p className="cli__sub">
              Paste this into <code>llama-cli</code> to chat with{' '}
              <span className="chip">{config.modelName}</span> from your terminal.
            </p>
          </div>
        </header>

        {bundle ? (
          <>
            <label className="cli__label" htmlFor="cli-bundle">
              Connection token
            </label>
            <textarea
              id="cli-bundle"
              className="cli__token"
              readOnly
              rows={4}
              value={bundle}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
            />
            <div className="cli__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void copy(bundle, 'bundle')}
              >
                {copied === 'bundle' ? 'Copied ✓' : 'Copy token'}
              </button>
              <button type="button" className="btn" onClick={onBackToChat}>
                Back to chat
              </button>
            </div>

            <div className="cli__meta">
              <span>
                Access token expires in{' '}
                <strong>{formatCountdown(msLeft)}</strong>
              </span>
              <button
                type="button"
                className="cli__linkbtn"
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken ? 'Hide raw access token' : 'Show raw access token'}
              </button>
            </div>

            {showToken && accessToken && (
              <>
                <textarea
                  className="cli__token cli__token--raw"
                  readOnly
                  rows={3}
                  value={accessToken}
                  onFocus={(e) => e.currentTarget.select()}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void copy(accessToken, 'token')}
                >
                  {copied === 'token' ? 'Copied ✓' : 'Copy access token only'}
                </button>
              </>
            )}

            <ol className="cli__steps">
              <li>
                Install the CLI (see <code>cli/README.md</code>) and run{' '}
                <code>llama-cli login</code>.
              </li>
              <li>Paste the connection token above when prompted.</li>
              <li>
                Start chatting — the CLI keeps your session alive by refreshing
                automatically.
              </li>
            </ol>

            <p className="cli__note">
              This token bundle includes a refresh token — it is a credential.
              Treat it like a password and don't share or commit it. Return to{' '}
              <code>{appOrigin}/#cli</code> any time to get a fresh one.
            </p>
          </>
        ) : (
          <p className="cli__sub" role="status">
            Preparing your token…
          </p>
        )}
      </div>
    </div>
  );
}
