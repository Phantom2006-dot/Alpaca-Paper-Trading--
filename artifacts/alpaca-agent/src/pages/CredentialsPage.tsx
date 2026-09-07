import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@clerk/react';
import { AlertTriangle, Check, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';

const apiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
const hasClerk = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

type CredentialStatus =
  | { state: 'none'; storage: null }
  | { state: 'memory'; storage: 'memory' }
  | { state: 'database'; storage: 'database'; keyLast4: string; updatedAt: string | null }
  | { state: 'unreadable'; storage: 'database'; message: string };

function describeStatus(status: CredentialStatus): { kind: 'none' | 'ok' | 'problem'; title: string; detail: string } {
  switch (status.state) {
    case 'database':
      return {
        kind: 'ok',
        title: `Paper credentials saved to your account · key ends in ${status.keyLast4 || '—'}`,
        detail: 'They are loaded automatically on every login — you only need to enter them once.',
      };
    case 'memory':
      return {
        kind: 'problem',
        title: 'Credentials active for this session only',
        detail: 'The API has no database configured, so keys are stored in server memory and will not survive a redeploy or restart.',
      };
    case 'unreadable':
      return {
        kind: 'problem',
        title: 'Credentials are on file but could not be decrypted',
        detail: status.message || 'This usually means the server encryption key changed. Re-enter your Alpaca keys to restore paper mode.',
      };
    default:
      return { kind: 'none', title: 'No paper credentials saved yet', detail: 'Enter your keys above to switch from demo mode to your paper account.' };
  }
}

function CredentialsForm({ getToken }: { getToken: () => Promise<string | null> }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!hasClerk) return;
    setStatusError(null);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch(`${apiUrl}/api/agent/credentials`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Status check failed with HTTP ${res.status}`);
      }
      setStatus((await res.json()) as CredentialStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Unable to check saved credentials.');
    }
  }, [getToken]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function save() {
    if (!apiKey.trim() || !apiSecret.trim()) {
      setNotice({ type: 'error', text: 'Both API key and secret are required.' });
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      const token = await getToken();
      if (hasClerk && !token) throw new Error('You must be signed in to connect Alpaca.');
      const res = await fetch(`${apiUrl}/api/agent/credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim() }),
      });
      const contentType = res.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json') ? await res.json() : { error: `API returned ${res.status} instead of JSON. Check the deployed API route.` };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save credentials');
      const savedToDatabase = data.persisted !== false;
      setNotice({
        type: savedToDatabase ? 'success' : 'warning',
        text: data.message ?? (savedToDatabase ? 'Credentials saved to your account.' : 'Credentials active for this session only.'),
      });
      setApiKey('');
      setApiSecret('');
      await loadStatus();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save credentials.' });
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove your saved Alpaca credentials? Paper orders will stop using your account and the agent returns to demo mode.')) return;
    setRemoving(true);
    setNotice(null);
    try {
      const token = await getToken();
      if (hasClerk && !token) throw new Error('You must be signed in.');
      const res = await fetch(`${apiUrl}/api/agent/credentials`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Failed to remove credentials');
      setNotice({ type: 'success', text: data?.message ?? 'Credentials removed.' });
      await loadStatus();
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Failed to remove credentials.' });
    } finally {
      setRemoving(false);
    }
  }

  const hasSaved = status?.state === 'database' || status?.state === 'memory';
  const summary = status ? describeStatus(status) : null;

  return (
    <>
      <div className="page-intro">
        <div>
          <div className="eyebrow">Settings / Alpaca credentials</div>
          <h1 className="page-title">Connect your paper account.</h1>
          <p className="page-description">
            Enter your Alpaca paper API key and secret. They are verified, encrypted at rest, and stored server-side scoped to your account — never logged or committed to source.
          </p>
        </div>
        <div className="mode-pill is-paper"><span className="mode-pill-dot" /> Paper only</div>
      </div>

      <div className="credentials-layout">
        <div className="panel credentials-form">
          <div className="card-header">
            <div>
              <div className="eyebrow">01 / paper API credentials</div>
              <h2 className="card-title">Alpaca paper account</h2>
            </div>
            <ShieldCheck size={18} className="text-primary" />
          </div>

          {summary && summary.kind !== 'none' && (
            <div className={cx('notice-banner', summary.kind === 'problem' && 'is-warning', summary.kind === 'ok' && 'is-success')}>
              {summary.kind === 'ok' ? <Check size={14} /> : <AlertTriangle size={14} />}
              <span>
                <strong>{summary.title}</strong>
                {summary.detail ? ` — ${summary.detail}` : ''}
              </span>
            </div>
          )}
          {statusError && (
            <div className="notice-banner is-warning">
              <AlertTriangle size={14} />
              <span>Could not load saved-credential status: {statusError}</span>
            </div>
          )}

          <div className="credentials-fields">
            <label>
              <span className="field-label">API Key ID</span>
              <div className="credentials-input-wrap">
                <KeyRound size={14} className="credentials-input-icon" />
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="PK…"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="input-alpaca-api-key"
                />
              </div>
            </label>
            <label>
              <span className="field-label">API Secret Key</span>
              <div className="credentials-input-wrap">
                <KeyRound size={14} className="credentials-input-icon" />
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  placeholder="••••••••••••••••"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="input-alpaca-api-secret"
                />
                <button
                  type="button"
                  className="credentials-eye-btn"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </label>
          </div>

          {notice && (
            <div className={cx('notice-banner', notice.type === 'error' && 'is-error', notice.type === 'warning' && 'is-warning')}>
              {notice.type === 'success' ? <Check size={14} /> : notice.type === 'warning' ? <AlertTriangle size={14} /> : <X size={14} />}
              <span>{notice.text}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={13} /></button>
            </div>
          )}

          <div className="credentials-footer">
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              {hasSaved
                ? 'You have active paper credentials. Saving again replaces them; Remove clears them and returns the agent to demo mode.'
                : 'Keys are verified against Alpaca, encrypted with AES-256-GCM, and stored in the database scoped to your account. They are loaded automatically on every login — you only need to enter them once.'}
            </div>
            <div className="flex items-center gap-2">
              {hasSaved && (
                <button
                  className="button button-danger"
                  onClick={() => void remove()}
                  disabled={removing || pending}
                  data-testid="button-remove-credentials"
                >
                  {removing ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  {removing ? 'Removing…' : 'Remove'}
                </button>
              )}
              <button
                className="button button-primary"
                onClick={() => void save()}
                disabled={pending || removing}
                data-testid="button-save-credentials"
              >
                {pending ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
                {pending ? 'Saving…' : 'Save credentials'}
              </button>
            </div>
          </div>
        </div>

        <div className="panel credentials-info-panel">
          <div className="eyebrow">How to get your paper API keys</div>
          <ol className="credentials-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Go to Alpaca</strong>
                <p>Visit <a href="https://app.alpaca.markets" target="_blank" rel="noopener noreferrer">app.alpaca.markets</a> and sign in or create a free account.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Switch to Paper Trading</strong>
                <p>In the top-right corner, toggle from "Live Trading" to "Paper Trading".</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Generate API Keys</strong>
                <p>Go to <strong>Overview → API Keys</strong> and click "Generate New Key". Copy both the key ID and secret immediately — the secret is only shown once.</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Paste above and save</strong>
                <p>Kairo will use these credentials for all paper order execution. No live trading is possible.</p>
              </div>
            </li>
          </ol>
          <div className="credentials-lock-note">
            <ShieldCheck size={14} />
            <span>Kairo is hardcoded to <code>paper-api.alpaca.markets</code>. Live order routing does not exist in this codebase.</span>
          </div>
        </div>
      </div>
    </>
  );
}

function AuthenticatedCredentialsPage() {
  const { getToken } = useAuth();
  return <CredentialsForm getToken={getToken} />;
}

export function CredentialsPage() {
  return hasClerk ? <AuthenticatedCredentialsPage /> : <CredentialsForm getToken={async () => null} />;
}
